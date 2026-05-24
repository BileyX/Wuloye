import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Flame, Plus, RefreshCw, X, GripVertical, Star, Users, DollarSign,
  Calendar, MapPin, Zap, Filter, TrendingUp,
} from "lucide-react";
import {
  getAdminTrending,
  createAdminTrending,
  updateAdminTrending,
  deleteAdminTrending,
  getAdminPlaces,
  getAdminEvents,
  getAdminRecommendationControl,
} from "@/services/endpoints";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { SkeletonCard } from "@/components/ui/loading";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTENT_TYPES = ["place", "event", "curated"];
const CATEGORIES = [
  "cafe", "restaurant", "gym", "hotel", "church", "mosque", "events",
  "workspace", "lounge", "sports", "entertainment", "festival", "nightlife",
  "travel", "park", "yoga", "shopping",
];
const AUDIENCE_OPTIONS = [
  "students", "professionals", "families", "couples", "religious",
  "fitness", "nightlife", "productivity", "senior", "solo",
];
const BUDGET_OPTIONS = ["all", "cheap", "medium", "expensive"];

const EMPTY_FORM = {
  contentId: "", contentType: "place", name: "", description: "",
  thumbnailUrl: "", category: "", city: "", rank: 10,
  active: true, audience: [], budgetLevel: "all", lifestyleType: "",
  startDate: "", endDate: "", aiBoostScore: 70, adminPriority: 70, tags: "",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  const map = {
    place:   "bg-blue-100 text-blue-800",
    event:   "bg-purple-100 text-purple-800",
    curated: "bg-amber-100 text-amber-800",
  };
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${map[type] ?? "bg-surface-overlay text-text-secondary"}`}>
      {type}
    </span>
  );
}

function AudienceTag({ tag }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full border border-border bg-surface-overlay text-text-secondary">
      {tag}
    </span>
  );
}

// ─── Create / Edit Form ───────────────────────────────────────────────────────

function TrendingForm({ initial, onSubmit, onCancel, isPending }) {
  const [form, setForm] = useState(initial ?? EMPTY_FORM);
  const set = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const toggleAud = (a) => setForm((f) => ({
    ...f,
    audience: f.audience.includes(a) ? f.audience.filter((x) => x !== a) : [...f.audience, a],
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? "Edit Trending Item" : "Add to Trending"}</CardTitle>
        <button type="button" onClick={onCancel} className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-overlay">
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Content reference */}
          <div className="space-y-1">
            <label className="label-xs">Content ID *</label>
            <input className="input-base" placeholder="Firestore doc ID" value={form.contentId} onChange={set("contentId")} />
          </div>
          <div className="space-y-1">
            <label className="label-xs">Content Type</label>
            <select className="input-base" value={form.contentType} onChange={set("contentType")}>
              {CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {/* Display */}
          <div className="space-y-1">
            <label className="label-xs">Display Name *</label>
            <input className="input-base" placeholder="Shown on mobile" value={form.name} onChange={set("name")} />
          </div>
          <div className="space-y-1">
            <label className="label-xs">Category</label>
            <select className="input-base" value={form.category} onChange={set("category")}>
              <option value="">Select…</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <label className="label-xs">Thumbnail URL</label>
            <input className="input-base" placeholder="https://…" value={form.thumbnailUrl} onChange={set("thumbnailUrl")} />
            {form.thumbnailUrl && (
              <img src={form.thumbnailUrl} alt="" className="mt-1 h-16 w-24 rounded-lg object-cover border border-border"
                onError={(e) => { e.target.style.display = "none"; }} />
            )}
          </div>

          <div className="space-y-1">
            <label className="label-xs">City</label>
            <input className="input-base" placeholder="Addis Ababa" value={form.city} onChange={set("city")} />
          </div>
          <div className="space-y-1">
            <label className="label-xs">Rank (lower = higher)</label>
            <input type="number" min={1} className="input-base" value={form.rank} onChange={set("rank")} />
          </div>

          {/* Date range */}
          <div className="space-y-1">
            <label className="label-xs">Start Date (optional)</label>
            <input type="date" className="input-base" value={form.startDate} onChange={set("startDate")} />
          </div>
          <div className="space-y-1">
            <label className="label-xs">End Date (optional)</label>
            <input type="date" className="input-base" value={form.endDate} onChange={set("endDate")} />
          </div>

          {/* Targeting */}
          <div className="space-y-1">
            <label className="label-xs">Budget Level</label>
            <select className="input-base" value={form.budgetLevel} onChange={set("budgetLevel")}>
              {BUDGET_OPTIONS.map((b) => <option key={b} value={b}>{b === "all" ? "All users" : b}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="label-xs">Lifestyle Type</label>
            <input className="input-base" placeholder="active, social, professional…" value={form.lifestyleType} onChange={set("lifestyleType")} />
          </div>

          {/* Audience */}
          <div className="sm:col-span-2 space-y-2">
            <span className="label-xs">Target Audience</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {AUDIENCE_OPTIONS.map((a) => (
                <button key={a} type="button" onClick={() => toggleAud(a)}
                  className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors ${
                    form.audience.includes(a)
                      ? "bg-stone-800 text-white border-stone-800"
                      : "bg-white text-text-secondary border-border hover:border-stone-400"
                  }`}
                >{a}</button>
              ))}
            </div>
          </div>

          {/* Boosts */}
          <div className="sm:col-span-2 space-y-4">
            {[["aiBoostScore","AI Boost Score"],["adminPriority","Admin Priority"]].map(([k,l]) => (
              <div key={k} className="space-y-1">
                <div className="flex justify-between"><span className="label-xs">{l}</span><span className="text-xs font-semibold tabular-nums">{form[k]}/100</span></div>
                <input type="range" min={0} max={100} step={5} value={form[k]}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }))}
                  className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
                />
              </div>
            ))}
          </div>

          {/* Active toggle */}
          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={set("active")} className="h-3.5 w-3.5" />
            Active (visible to users)
          </label>
        </div>

        <div className="flex gap-2 pt-5 mt-5 border-t border-border-subtle">
          <Button variant="secondary" onClick={onCancel} disabled={isPending}>Cancel</Button>
          <Button onClick={() => onSubmit({ ...form, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) })}
            disabled={isPending || !form.contentId.trim() || !form.name.trim()}>
            <Flame className="h-3.5 w-3.5" />
            {isPending ? "Saving…" : initial ? "Update" : "Add to Trending"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Trending Item Card ───────────────────────────────────────────────────────

function TrendingItemCard({ item, onEdit, onDelete, onToggle, isMutating }) {
  return (
    <Card className={`relative overflow-hidden transition-opacity ${item.active ? "" : "opacity-60"}`}>
      {item.thumbnailUrl && (
        <div className="h-24 w-full overflow-hidden border-b border-border-subtle">
          <img src={item.thumbnailUrl} alt={item.name} className="h-full w-full object-cover"
            onError={(e) => { e.target.parentElement.style.display = "none"; }} />
        </div>
      )}

      <CardContent className="pt-3 pb-3">
        {/* Rank badge */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-stone-800 text-white text-[10px] font-bold">
              #{item.rank}
            </div>
            <TypeBadge type={item.contentType} />
            {item.category && (
              <span className="text-[10px] text-text-tertiary capitalize">{item.category}</span>
            )}
          </div>
          <div className={`h-2 w-2 rounded-full ${item.active ? "bg-emerald-500" : "bg-border"}`} />
        </div>

        <p className="text-sm font-semibold text-text-primary mb-0.5">{item.name}</p>
        {item.city && (
          <p className="text-[11px] text-text-tertiary flex items-center gap-1 mb-2">
            <MapPin className="h-3 w-3" /> {item.city}
          </p>
        )}

        {/* Targeting info */}
        {(item.budgetLevel !== "all" || item.audience?.length > 0) && (
          <div className="flex flex-wrap gap-1 mb-2">
            {item.budgetLevel && item.budgetLevel !== "all" && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800">{item.budgetLevel}</span>
            )}
            {(item.audience ?? []).slice(0, 3).map((a) => <AudienceTag key={a} tag={a} />)}
            {(item.audience ?? []).length > 3 && (
              <span className="text-[10px] text-text-tertiary">+{item.audience.length - 3}</span>
            )}
          </div>
        )}

        {/* Date range */}
        {(item.startDate || item.endDate) && (
          <p className="text-[10px] text-text-tertiary flex items-center gap-1 mb-2">
            <Calendar className="h-3 w-3" />
            {item.startDate ? item.startDate.slice(0,10) : "…"} → {item.endDate ? item.endDate.slice(0,10) : "ongoing"}
          </p>
        )}

        {/* Boost meters */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-md bg-surface-overlay border border-border-subtle px-2 py-1.5">
            <div className="text-[9px] text-text-tertiary mb-0.5">AI Boost</div>
            <div className="h-1 rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-stone-800" style={{ width: `${item.aiBoostScore ?? 0}%` }} />
            </div>
            <div className="text-[9px] text-text-primary font-medium mt-0.5">{item.aiBoostScore ?? 0}/100</div>
          </div>
          <div className="rounded-md bg-surface-overlay border border-border-subtle px-2 py-1.5">
            <div className="text-[9px] text-text-tertiary mb-0.5">Priority</div>
            <div className="h-1 rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-stone-600" style={{ width: `${item.adminPriority ?? 0}%` }} />
            </div>
            <div className="text-[9px] text-text-primary font-medium mt-0.5">{item.adminPriority ?? 0}/100</div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-1.5 flex-wrap">
          <Button size="sm" variant="secondary" className="flex-1"
            onClick={() => onToggle(item.id, !item.active)} disabled={isMutating}>
            {item.active ? "Pause" : "Activate"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onEdit(item)}>
            <Zap className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="secondary" className="text-red-500"
            onClick={() => { if (window.confirm(`Remove "${item.name}" from trending?`)) onDelete(item.id); }}
            disabled={isMutating}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Quick-add from catalogue ─────────────────────────────────────────────────

function QuickAddCatalog({ onAdd, isPending, existingIds }) {
  const [tab, setTab] = useState("places");
  const [search, setSearch] = useState("");

  const placesQuery = useQuery({
    queryKey: ["trending-quick-places"],
    queryFn: getAdminPlaces,
    enabled: tab === "places",
  });
  const eventsQuery = useQuery({
    queryKey: ["trending-quick-events"],
    queryFn: () => getAdminEvents({ limit: 100 }),
    enabled: tab === "events",
  });
  const curatedQuery = useQuery({
    queryKey: ["trending-quick-curated"],
    queryFn: () => getAdminRecommendationControl({ limit: 100 }),
    enabled: tab === "curated",
  });

  const places = placesQuery.data?.places ?? placesQuery.data?.data ?? [];
  const events = eventsQuery.data?.events ?? eventsQuery.data?.data ?? [];
  const curated = curatedQuery.data?.data ?? [];

  const rows = tab === "places" ? places : tab === "events" ? events : curated;
  const filtered = rows.filter((r) => {
    const name = (r.name ?? r.title ?? "").toLowerCase();
    return !search || name.includes(search.toLowerCase());
  });

  const handlePick = (row) => {
    if (tab === "places") {
      onAdd({
        contentId: row.id,
        contentType: "place",
        name: row.name,
        description: row.description ?? "",
        thumbnailUrl: row.images?.[0] ?? row.thumbnailUrl ?? null,
        category: row.type ?? row.category ?? "place",
        city: row.location?.city ?? row.city ?? "",
        rank: 10,
        active: true,
        budgetLevel: "all",
      });
    } else if (tab === "events") {
      onAdd({
        contentId: row.id,
        contentType: "event",
        name: row.title,
        description: row.description ?? "",
        thumbnailUrl: row.image ?? null,
        category: row.category ?? "event",
        city: row.city ?? row.location ?? "",
        rank: 10,
        active: true,
        budgetLevel: "all",
      });
    } else {
      onAdd({
        contentId: row.id,
        contentType: "curated",
        name: row.name,
        description: row.description ?? "",
        thumbnailUrl: row.thumbnailUrl ?? row.coverUrl ?? null,
        category: row.category ?? "place",
        city: row.city ?? row.location?.city ?? "",
        rank: 10,
        active: true,
        budgetLevel: "all",
        audience: row.audienceTags ?? [],
      });
    }
  };

  const existing = new Set(existingIds ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick add from catalogue</CardTitle>
        <p className="text-xs text-text-tertiary">Pick a place, event, or curated recommendation — no manual IDs needed.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {["places", "events", "curated"].map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium capitalize transition-colors ${
                tab === t ? "bg-stone-800 text-white border-stone-800" : "bg-white text-text-secondary border-border"
              }`}
            >{t}</button>
          ))}
        </div>
        <input
          className="input-base"
          placeholder={`Search ${tab}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-56 overflow-y-auto space-y-1.5 border border-border-subtle rounded-lg p-2">
          {(tab === "places" ? placesQuery.isLoading : tab === "events" ? eventsQuery.isLoading : curatedQuery.isLoading) ? (
            <p className="text-xs text-text-tertiary p-2">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-text-tertiary p-2">No {tab} found.</p>
          ) : filtered.slice(0, 40).map((row) => {
            const id = row.id;
            const label = row.name ?? row.title ?? id;
            const already = existing.has(`${tab === "events" ? "event" : tab === "curated" ? "curated" : "place"}:${id}`);
            return (
              <div key={id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-overlay">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text-primary truncate">{label}</p>
                  <p className="text-[10px] text-text-tertiary truncate">{row.type ?? row.category ?? tab}</p>
                </div>
                <Button size="xs" variant="secondary" disabled={isPending || already}
                  onClick={() => handlePick(row)}>
                  {already ? "Added" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TrendingManagementPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");

  const listQuery = useQuery({
    queryKey: ["admin-trending", typeFilter],
    queryFn: () => getAdminTrending(typeFilter !== "all" ? { type: typeFilter } : {}),
  });

  const createMut = useMutation({
    mutationFn: createAdminTrending,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-trending"] }); setShowForm(false); },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateAdminTrending(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-trending"] }); setEditing(null); },
  });
  const deleteMut = useMutation({
    mutationFn: deleteAdminTrending,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-trending"] }),
  });

  const items = listQuery.data?.data ?? [];
  const isMutating = deleteMut.isPending || updateMut.isPending || createMut.isPending;

  const existingContentKeys = items.map((i) => `${i.contentType}:${i.contentId}`);

  const activeCount  = items.filter((i) => i.active).length;
  const placeCount   = items.filter((i) => i.contentType === "place").length;
  const eventCount   = items.filter((i) => i.contentType === "event").length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Flame className="h-5 w-5 text-orange-500" />
            <h2 className="page-title">Trending Management</h2>
          </div>
          <p className="page-sub">Control what appears in the mobile Trending section — personalized by audience, budget, and behavior</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["admin-trending"] })}>
            <RefreshCw className={`h-3.5 w-3.5 ${listQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="h-3.5 w-3.5" />
            Add Trending
          </Button>
        </div>
      </div>

      {/* Errors */}
      {listQuery.isError && <Alert variant="error">{listQuery.error?.message}</Alert>}
      {createMut.isError && <Alert variant="error">{createMut.error?.message}</Alert>}

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Total Items",   value: items.length,  icon: TrendingUp },
          { label: "Active",        value: activeCount,   icon: Flame },
          { label: "Places",        value: placeCount,    icon: MapPin },
          { label: "Events",        value: eventCount,    icon: Calendar },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="label-xs mb-1">{label}</p>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">{value}</p>
                </div>
                <Icon className="h-4 w-4 text-text-tertiary mt-1" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Personalization notice */}
      <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-800">
        <Flame className="h-4 w-4 mt-0.5 shrink-0 text-orange-500" />
        <div>
          <strong>Personalized Trending:</strong> Users see different trending content based on their onboarding profile, budget, and behavior. Orthodox users won't see nightlife trends. Students see affordable options. Budget and audience targeting is applied on the mobile app.
        </div>
      </div>

      {/* Quick add */}
      <QuickAddCatalog
        existingIds={existingContentKeys}
        isPending={createMut.isPending}
        onAdd={(data) => createMut.mutate(data)}
      />

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <Filter className="h-3.5 w-3.5 text-text-tertiary" />
        {["all", ...CONTENT_TYPES].map((t) => (
          <button key={t} type="button" onClick={() => setTypeFilter(t)}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
              typeFilter === t
                ? "bg-stone-800 text-white border-stone-800"
                : "bg-white text-text-secondary border-border hover:border-stone-400"
            }`}
          >{t === "all" ? "All Types" : t}</button>
        ))}
      </div>

      {/* Form */}
      {showForm && !editing && (
        <TrendingForm
          onSubmit={(data) => createMut.mutate(data)}
          onCancel={() => setShowForm(false)}
          isPending={createMut.isPending}
        />
      )}
      {editing && (
        <TrendingForm
          initial={{ ...EMPTY_FORM, ...editing, tags: (editing.tags ?? []).join(", ") }}
          onSubmit={(data) => updateMut.mutate({ id: editing.id, data })}
          onCancel={() => setEditing(null)}
          isPending={updateMut.isPending}
        />
      )}

      {/* Grid */}
      {listQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => <SkeletonCard key={i} className="h-52" />)}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Flame className="h-10 w-10 text-text-tertiary mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium text-text-secondary mb-1">No trending items yet</p>
            <p className="text-xs text-text-tertiary mb-4">Add places or events to control what users see in the Trending section.</p>
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add First Item
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <TrendingItemCard
              key={item.id}
              item={item}
              onEdit={setEditing}
              onDelete={(id) => deleteMut.mutate(id)}
              onToggle={(id, active) => updateMut.mutate({ id, data: { active } })}
              isMutating={isMutating}
            />
          ))}
        </div>
      )}
    </div>
  );
}
