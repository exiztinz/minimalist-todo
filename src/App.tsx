import { useEffect, useMemo, useState, useRef, useCallback } from "react";

/**
 * Minimalist Daily / Weekly / Monthly counters + Section Streaks
 * - Global “Add” with choice of period (no per-section add buttons)
 * - Sections render only when they contain at least one item
 * - Each item has: title, target per period, count (progress in current period)
 * - Big +1 button increments up to target (no overflow) and -1 decrements (no negative)
 * - Minimal horizontal progress bar (0..100%) in 1/target steps
 * - LocalStorage persistence
 * - Auto-reset counts on day/week/month boundary
 * - SECTION STREAKS: streak increments only if ALL items in that section reached target
 *   during the period that just ended. Anti-cheat: increments only on rollover.
 *   Live preview: header shows streak +1 if all are currently done; if you undo one,
 *   the preview drops until all are done again.
 */

// ---------- Types ----------
const PERIODS = ["daily", "weekly", "monthly"] as const;
type Period = typeof PERIODS[number];

type Item = {
  id: string;
  title: string;
  period: Period;
  count: number; // progress within current period
  target: number; // desired per-period count (>=1)
  periodKey: string; // e.g., 2025-10-06 | 2025-W41 | 2025-10
  streak: number; // kept for per-item legacy compat (not used for section rules)
  bestStreak: number;
};

type Draft = Partial<Pick<Item, "title" | "period" | "count" | "target">>;

// Section-level streaks
type SectionStreaks = {
  daily: number;
  weekly: number;
  monthly: number;
  bestDaily: number;
  bestWeekly: number;
  bestMonthly: number;
};

// ---------- Date helpers ----------
function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

function getISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO week number (Mon=1..Sun=7) using LOCAL time so it aligns with daily/monthly
function getISOWeek(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay(): Sun=0..Sat=6 → map to ISO Mon=1..Sun=7
  let day = date.getDay();
  if (day === 0) day = 7;

  // Move to Thursday in current week
  date.setDate(date.getDate() + (4 - day));

  // First day of the year
  const yearStart = new Date(date.getFullYear(), 0, 1);

  // Calculate week number
  const days = Math.floor((date.getTime() - yearStart.getTime()) / 86400000) + 1;
  const weekNo = Math.ceil(days / 7);

  return `${date.getFullYear()}-W${weekNo}`;
}

function getMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function periodKey(period: Period, d = new Date()) {
  switch (period) {
    case "daily":
      return getISODate(d);
    case "weekly":
      return getISOWeek(d);
    case "monthly":
      return getMonthKey(d);
  }
}

// ---------- Storage ----------
const LS_KEY = "mhc:v3"; // version with section-level streaks + targets
const LS_STREAKS_KEY = "mhc:section-streaks:v1";

function safeGet(k: string) {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  } catch { }
}

function loadItems(): Item[] {
  try {
    const raw = safeGet(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Item[];
      return arr.map((it) => ({
        ...it,
        periodKey: it.periodKey ?? periodKey(it.period),
        count: Math.max(0, Number(it.count) || 0),
        target: Math.max(1, Number((it as any).target) || 1),
        streak: typeof it.streak === "number" ? it.streak : 0,
        bestStreak: typeof it.bestStreak === "number" ? it.bestStreak : 0,
      }));
    }
    // migrate v2 -> v3
    const rawV2 = safeGet("mhc:v2");
    if (rawV2) {
      const arr = JSON.parse(rawV2) as any[];
      return arr.map((it) => ({
        id: it.id,
        title: it.title,
        period: it.period,
        count: Math.max(0, Number(it.count) || 0),
        target: 1,
        periodKey: it.periodKey ?? periodKey(it.period),
        streak: it.streak ?? 0,
        bestStreak: it.bestStreak ?? 0,
      }));
    }
    const rawV1 = safeGet("mhc:v1");
    if (!rawV1) return [];
    const arrV1 = JSON.parse(rawV1) as any[];
    return arrV1.map((it) => ({
      id: it.id,
      title: it.title,
      period: it.period,
      count: Math.max(0, Number(it.count) || 0),
      target: 1,
      periodKey: it.periodKey ?? periodKey(it.period),
      streak: 0,
      bestStreak: 0,
    }));
  } catch {
    return [];
  }
}

function saveItems(items: Item[]) {
  safeSet(LS_KEY, JSON.stringify(items));
}

function loadSectionStreaks(): SectionStreaks {
  try {
    const raw = safeGet(LS_STREAKS_KEY);
    if (!raw)
      return {
        daily: 0,
        weekly: 0,
        monthly: 0,
        bestDaily: 0,
        bestWeekly: 0,
        bestMonthly: 0,
      };
    const s = JSON.parse(raw);
    return {
      daily: s.daily ?? 0,
      weekly: s.weekly ?? 0,
      monthly: s.monthly ?? 0,
      bestDaily: s.bestDaily ?? 0,
      bestWeekly: s.bestWeekly ?? 0,
      bestMonthly: s.bestMonthly ?? 0,
    };
  } catch {
    return { daily: 0, weekly: 0, monthly: 0, bestDaily: 0, bestWeekly: 0, bestMonthly: 0 };
  }
}

function saveSectionStreaks(ss: SectionStreaks) {
  safeSet(LS_STREAKS_KEY, JSON.stringify(ss));
}

// ---------- UI Primitives ----------
function Section({
  title,
  children,
  streakDisplay,
  best,
}: {
  title: string;
  children: React.ReactNode;
  streakDisplay?: number;
  best?: number;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium tracking-tight text-gray-900 dark:text-gray-100">{title}</h2>
        {typeof streakDisplay === "number" && (
          <div className="text-xs text-gray-600 dark:text-gray-300">
            Streak: <span className="tabular-nums font-semibold">{streakDisplay}</span>
            {typeof best === "number" && <span className="opacity-70"> &nbsp;• Best {best}</span>}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200/70 dark:border-gray-700/70 bg-white dark:bg-gray-900 shadow-sm p-4">
      {children}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  type = "button",
}: {
  label: string;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type} // ← critical: default is "button", not "submit"
      onClick={onClick}
      className="px-2 py-1 rounded-xl border border-gray-200/70 dark:border-gray-700/70 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      {label}
    </button>
  );
}

function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-center rounded-xl px-4 py-3 border border-gray-200/70 dark:border-gray-700/70 hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      <span className="text-2xl font-semibold tabular-nums">{label}</span>
    </button>
  );
}

function Modal({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl bg-white dark:bg-gray-900 border border-gray-200/70 dark:border-gray-700/70 shadow-xl p-4"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-sm opacity-70 hover:opacity-100">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm mb-3">
      <span className="block text-gray-600 dark:text-gray-300 mb-1">{label}</span>
      {children}
    </label>
  );
}

// ---------- Main Component ----------
export default function MinimalHabitCountersApp() {
  const [items, setItems] = useState<Item[]>(() => loadItems());
  const [sectionStreaks, setSectionStreaks] = useState<SectionStreaks>(() => loadSectionStreaks());
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Editing modal state
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingItem = useMemo(() => items.find((i) => i.id === editingId) || null, [items, editingId]);

  // New item modal state
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ title: "", period: "daily", count: 0, target: 1 });

  // Persist
  useEffect(() => saveItems(items), [items]);
  useEffect(() => saveSectionStreaks(sectionStreaks), [sectionStreaks]);

  // ---------- Rollover logic (shared) ----------
  const rollover = useCallback(
    (now: Date) => {
      // Detect period boundary per section (compare current key vs stored key)
      const boundaryDaily = items.some((i) => i.period === "daily" && periodKey("daily", now) !== i.periodKey);
      const boundaryWeekly = items.some((i) => i.period === "weekly" && periodKey("weekly", now) !== i.periodKey);
      const boundaryMonthly = items.some((i) => i.period === "monthly" && periodKey("monthly", now) !== i.periodKey);

      if (!boundaryDaily && !boundaryWeekly && !boundaryMonthly) return; // no boundary -> do nothing

      // Determine completion for sections that actually ended (based on counts BEFORE reset)
      function allDone(period: Period) {
        const list = items.filter((i) => i.period === period);
        if (list.length === 0) return false;
        return list.every((i) => i.count >= Math.max(1, i.target));
      }
      const endedDailyDone = boundaryDaily && allDone("daily");
      const endedWeeklyDone = boundaryWeekly && allDone("weekly");
      const endedMonthlyDone = boundaryMonthly && allDone("monthly");

      // Update section streaks (increments once per boundary only)
      setSectionStreaks((s) => {
        let { daily, weekly, monthly, bestDaily, bestWeekly, bestMonthly } = s;
        if (boundaryDaily) {
          daily = endedDailyDone ? daily + 1 : 0;
          bestDaily = Math.max(bestDaily, daily);
        }
        if (boundaryWeekly) {
          weekly = endedWeeklyDone ? weekly + 1 : 0;
          bestWeekly = Math.max(bestWeekly, weekly);
        }
        if (boundaryMonthly) {
          monthly = endedMonthlyDone ? monthly + 1 : 0;
          bestMonthly = Math.max(bestMonthly, monthly);
        }
        return { daily, weekly, monthly, bestDaily, bestWeekly, bestMonthly };
      });

      // Reset item progress for sections that ended
      setItems((prev) =>
        prev.map((it) => {
          const currentKey = periodKey(it.period, now);
          if (currentKey !== it.periodKey) {
            return { ...it, periodKey: currentKey, count: 0 };
          }
          return it;
        })
      );
    },
    [items, setItems, setSectionStreaks]
  );

  // Run rollover immediately and every hour
  useEffect(() => {
    const check = () => rollover(new Date());
    check(); // immediate (handles time while app was closed)
    const t = setInterval(check, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [rollover]);

  // 🔔 (5) Also run rollover when app regains focus or becomes visible
  useEffect(() => {
    const check = () => rollover(new Date());
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [rollover]);

  // Derived lists
  const byPeriod = useMemo(() => {
    const map: Record<Period, Item[]> = { daily: [], weekly: [], monthly: [] };
    for (const it of items) map[it.period].push(it);
    return map;
  }, [items]);

  function makeId() {
    const c = (globalThis as any).crypto;
    return c?.randomUUID ? c.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function addItem(title: string, period: Period) {
    const it: Item = {
      id: makeId(),
      title: title.trim() || "Untitled",
      period,
      count: 0,
      target: 1,
      periodKey: periodKey(period),
      streak: 0,
      bestStreak: 0,
    };
    setItems((prev) => [it, ...prev]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  function increment(id: string) {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const next = Math.min((it.count || 0) + 1, Math.max(1, it.target));
    updateItem(id, { count: next });
  }

  function decrement(id: string) {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const next = Math.max(0, (it.count || 0) - 1);
    updateItem(id, { count: next });
  }

  // UI helpers
  function TitleBar() {
    const [showAddMenu, setShowAddMenu] = useState(false);
    const addMenuRef = useRef<HTMLDivElement>(null);

    // Close on outside click (pointer) and on Escape — same as the "⋯" menu
    useEffect(() => {
      if (!showAddMenu) return;
      const onPointerDown = (e: PointerEvent) => {
        if (!addMenuRef.current) return;
        if (!addMenuRef.current.contains(e.target as Node)) {
          setShowAddMenu(false);
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setShowAddMenu(false);
      };
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [showAddMenu]);

    return (
      <div className="sticky top-0 z-40 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-gray-950/60 bg-white/80 dark:bg-gray-950/80 border-b border-gray-200/70 dark:border-gray-800">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="text-sm tracking-wide uppercase text-gray-500">Minimal Counters</div>

          {/* Wrap trigger + menu so outside clicks are detectable */}
          <div className="relative" ref={addMenuRef}>
            <button
              type="button"
              onClick={() => setShowAddMenu((s) => !s)}
              className="rounded-xl border border-gray-200/70 dark:border-gray-700/70 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
              aria-haspopup="menu"
              aria-expanded={showAddMenu}
              aria-label="Add counter"
            >
              Add
            </button>

            {showAddMenu && (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-10"
              >
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShowAddMenu(false);
                      setDraft({ title: "", period: p, count: 0, target: 1 });
                      setNewOpen(true);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 capitalize"
                  >
                    Add {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function ItemCard({ it }: { it: Item }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const pct = Math.min(1, (it.count || 0) / Math.max(1, it.target));

    // Close on outside click (or tap) and on Escape
    useEffect(() => {
      if (!menuOpen) return;
      const onPointerDown = (e: PointerEvent) => {
        if (!menuRef.current) return;
        if (!menuRef.current.contains(e.target as Node)) {
          setMenuOpen(false);
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setMenuOpen(false);
      };
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [menuOpen]);

    return (
      <Card>
        <div className="flex items-start justify-between mb-2">
          <div className="font-medium text-gray-900 dark:text-gray-100 truncate" title={it.title}>
            {it.title}
          </div>

          {/* Wrap trigger + menu so outside clicks are detectable */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((s) => !s)}
              className="-m-1 px-2 py-1 rounded-lg text-sm opacity-70 hover:opacity-100 border border-transparent hover:border-gray-200/70 dark:hover:border-gray-700/70"
              aria-label="Item menu"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              ⋯
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-10"
              >
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditingId(it.id);
                  }}
                >
                  Edit
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={() => {
                    const val = prompt("Set count to:", String(it.count));
                    if (val == null) return;
                    const n = Math.max(0, Math.floor(Number(val) || 0));
                    updateItem(it.id, { count: Math.min(n, Math.max(1, it.target)) });
                    setMenuOpen(false);
                  }}
                >
                  Set count…
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={() => {
                    const val = prompt("Set target to:", String(it.target));
                    if (val == null) return;
                    const t = Math.max(1, Math.floor(Number(val) || 1));
                    const newCount = Math.min(it.count, t);
                    updateItem(it.id, { target: t, count: newCount });
                    setMenuOpen(false);
                  }}
                >
                  Set target…
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 text-red-600"
                  onClick={() => {
                    if (confirm("Delete this item?")) {
                      removeItem(it.id);
                    }
                    setMenuOpen(false);
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
          <div className="h-full rounded-full bg-gray-900 dark:bg-gray-200 transition-all" style={{ width: `${pct * 100}%` }} />
        </div>

        <div className="mt-2 flex items-center justify-between text-xs text-gray-600 dark:text-gray-300">
          <span className="capitalize">{it.period}</span>
          <span className="tabular-nums">{it.count}/{Math.max(1, it.target)}</span>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => decrement(it.id)}
            className="w-full text-center rounded-xl px-4 py-3 border border-gray-200/70 dark:border-gray-700/70 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <span className="text-base font-medium">-1</span>
          </button>
          <PrimaryButton label={"+1"} onClick={() => increment(it.id)} />
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500">
          <span className="opacity-70">Reset: {it.periodKey}</span>
        </div>
      </Card>
    );
  }

  function NewItemModal() {
    const titleRef = useRef<HTMLInputElement>(null);

    // Local state, just like EditItemModal
    const [tmp, setTmp] = useState<Draft>({});

    // Seed local state when the modal opens, then focus title ONCE
    useEffect(() => {
      if (newOpen) {
        setTmp({
          title: draft.title ?? "",
          period: (draft.period as Period) ?? "daily",
          target: draft.target ?? 1,
        });
        // focus after paint
        const id = setTimeout(() => titleRef.current?.focus(), 0);
        return () => clearTimeout(id);
      }
    }, [newOpen, draft.title, draft.period, draft.target]);

    if (!newOpen) return null;

    return (
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Add counter">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const period = (tmp.period as Period) || "daily";
            const tgt = Math.max(1, Number(tmp.target) || 1);

            // create with count=0, then set target on the newly added item
            addItem(String(tmp.title || "Untitled"), period);
            setItems((prev) => {
              if (prev.length === 0) return prev;
              const [first, ...rest] = prev;
              return [{ ...first, target: tgt, count: Math.min(first.count, tgt) }, ...rest];
            });

            setNewOpen(false);
          }}
        >
          <Field label="Title">
            <input
              type="text"
              ref={titleRef}
              className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
              value={tmp.title ?? ""}
              onChange={(e) => setTmp((d) => ({ ...d, title: e.target.value }))}
              placeholder="e.g., Push-ups"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Period">
              <select
                className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
                value={tmp.period as any}
                onChange={(e) => setTmp((d) => ({ ...d, period: e.target.value as Period }))}
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p} className="capitalize">
                    {p}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Target (per period)">
              <input
                type="number"
                inputMode="numeric"
                step={1}
                // allow empty while typing; clamp on blur/submit
                className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
                value={tmp.target === undefined ? "" : tmp.target}
                onChange={(e) => {
                  const v = e.target.value;
                  setTmp((d) => ({ ...d, target: v === "" ? undefined : Number(v) }));
                }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  setTmp((d) => ({ ...d, target: Math.max(1, isNaN(v) ? 1 : v) }));
                }}
              />
            </Field>
          </div>

          <div className="flex items-center justify-end gap-2 mt-2">
            <IconButton label="Cancel" type="button" onClick={() => setNewOpen(false)} />
            <IconButton label="Create" type="submit" />
          </div>
        </form>
      </Modal>
    );
  }

  function EditItemModal() {
    const titleRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      if (editingItem) titleRef.current?.focus(); // focus only once when modal opens
    }, [editingItem]);

    const [tmp, setTmp] = useState<Draft>(() => {
      if (!editingItem) return {};
      return { title: editingItem.title, period: editingItem.period, target: editingItem.target };
    });

    useEffect(() => {
      if (editingItem) setTmp({ title: editingItem.title, period: editingItem.period, target: editingItem.target });
    }, [editingItem]);

    if (!editingItem) return null;

    return (
      <Modal open={!!editingItem} onClose={() => setEditingId(null)} title="Edit counter">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!editingItem) return;
            const tgt = Math.max(1, Number(tmp.target) || editingItem.target || 1);
            const newCount = Math.min(editingItem.count, tgt); // clamp in case target lowered
            updateItem(editingItem.id, {
              title: String(tmp.title || "Untitled"),
              period: (tmp.period as Period) || editingItem.period,
              count: newCount,
              target: tgt,
              periodKey: (tmp.period as Period) && tmp.period !== editingItem.period ? periodKey(tmp.period as Period) : editingItem.periodKey,
            });
            setEditingId(null);
          }}
        >
          <Field label="Title">
            <input
              type="text"
              ref={titleRef}
              className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
              value={tmp.title ?? ""}
              onChange={(e) => setTmp((d) => ({ ...d, title: e.target.value }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period">
              <select
                className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
                value={tmp.period as any}
                onChange={(e) => setTmp((d) => ({ ...d, period: e.target.value as Period }))}
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p} className="capitalize">
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Target (per period)">
              <input
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                className="w-full rounded-xl border border-gray-200/70 dark:border-gray-700/70 bg-transparent px-3 py-2"
                value={tmp.target === undefined ? "" : tmp.target}
                onChange={(e) => {
                  const v = e.target.value;
                  setTmp((d) => ({ ...d, target: v === "" ? undefined : Number(v) }));
                }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  setTmp((d) => ({ ...d, target: Math.max(1, isNaN(v) ? 1 : v) }));
                }}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between mt-3">
            <button
              type="button"
              className="text-red-600 text-sm opacity-80 hover:opacity-100"
              onClick={() => {
                if (!editingItem) return;
                if (confirm("Delete this item?")) {
                  removeItem(editingItem.id);
                  setEditingId(null);
                }
              }}
            >
              Delete
            </button>
            <div className="flex items-center gap-2">
              <IconButton label="Cancel" onClick={() => setEditingId(null)} />
              <IconButton
                label="Save"
                onClick={() => {
                  if (!editingItem) return;
                  const tgt = Math.max(1, Number(tmp.target) || editingItem.target || 1);
                  const newCount = Math.min(editingItem.count, tgt);
                  updateItem(editingItem.id, {
                    title: String(tmp.title || "Untitled"),
                    period: (tmp.period as Period) || editingItem.period,
                    count: newCount,
                    target: tgt,
                    periodKey: (tmp.period as Period) && tmp.period !== editingItem.period ? periodKey(tmp.period as Period) : editingItem.periodKey,
                  });
                  setEditingId(null);
                }}
              />
            </div>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <TitleBar />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-8">
        {items.length === 0 && (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-2xl p-8 text-center text-sm text-gray-600 dark:text-gray-300">
            No counters yet. Use <span className="font-semibold">Add</span> to create Daily, Weekly, or Monthly counters.
          </div>
        )}

        {/* Live headers show previewed streak = stored + (allDone ? 1 : 0) */}
        {(() => {
          const hasDaily = items.some((i) => i.period === "daily");
          const hasWeekly = items.some((i) => i.period === "weekly");
          const hasMonthly = items.some((i) => i.period === "monthly");
          const dailyDone = hasDaily && items.filter((i) => i.period === "daily").every((i) => i.count >= Math.max(1, i.target));
          const weeklyDone = hasWeekly && items.filter((i) => i.period === "weekly").every((i) => i.count >= Math.max(1, i.target));
          const monthlyDone = hasMonthly && items.filter((i) => i.period === "monthly").every((i) => i.count >= Math.max(1, i.target));

          return (
            <>
              {hasDaily && (
                <Section title="Daily" streakDisplay={sectionStreaks.daily + (dailyDone ? 1 : 0)} best={sectionStreaks.bestDaily}>
                  {byPeriod.daily.map((it) => (
                    <ItemCard key={it.id} it={it} />
                  ))}
                </Section>
              )}

              {hasWeekly && (
                <Section title="Weekly" streakDisplay={sectionStreaks.weekly + (weeklyDone ? 1 : 0)} best={sectionStreaks.bestWeekly}>
                  {byPeriod.weekly.map((it) => (
                    <ItemCard key={it.id} it={it} />
                  ))}
                </Section>
              )}

              {hasMonthly && (
                <Section title="Monthly" streakDisplay={sectionStreaks.monthly + (monthlyDone ? 1 : 0)} best={sectionStreaks.bestMonthly}>
                  {byPeriod.monthly.map((it) => (
                    <ItemCard key={it.id} it={it} />
                  ))}
                </Section>
              )}
            </>
          );
        })()}
      </main>

      {/* Modals */}
      <NewItemModal />
      <EditItemModal />
    </div>
  );
}
