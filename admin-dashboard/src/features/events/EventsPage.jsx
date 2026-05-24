import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Flame, Plus, RefreshCw, Search, Star, X, Zap } from "lucide-react";
import {
  createAdminEvent,
  deleteAdminEvent,
  getAdminEvents,
  getEventsStats,
  setEventFeatured,
  updateAdminEvent,
} from "@/services/endpoints";
import { apiClient } from "@/services/apiClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { LoadingState, SkeletonRow, SkeletonCard } from "@/components/ui/loading";
import { cn } from "@/utils/cn";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch { return iso; }
}

const CATEGORIES = [
  "music", "tech", "church", "fitness", "business",
  "food", "art", "sports", "education", "social", "other",
];

const SOURCE_LABELS = {
  alladdisevents:           "AllAddis",
  whatsupaddis:             "WhatsUp",
  telegram_events_ethiopia: "Telegram",
};

/* ── Edit Modal ─────────────────────────────────────────────────────────── */
function EditModal({ event, onClose, onSave, isPending }) {
  const [form, setForm] = useState({
    title:       event.title || "",
    description: event.description || "",
    location:    event.location || "",
    category:    event.category || "other",
    date:        event.date ? event.date.slice(0, 10) : "",
    image:       event.image || "",
    source_url:  event.source_url || "",
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-lg rounded-xl p-6 space-y-4 animate-fade-in max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", boxShadow: "0 16px 48px rgba(0,0,0,0.12)" }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Edit Event</h2>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-overlay transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {[
            { label: "Title",      key: "title" },
            { label: "Location",   key: "location" },
            { label: "Image URL",  key: "image" },
            { label: "Source URL", key: "source_url" },
          ].map(({ label, key }) => (
            <div key={key} className="space-y-1">
              <label className="label-xs">{label}</label>
              <input type="text" value={form[key]} onChange={set(key)} className="input-base" />
            </div>
          ))}

          <div className="space-y-1">
            <label className="label-xs">Date</label>
            <input type="date" value={form.date} onChange={set("date")} className="input-base" />
          </div>

          <div className="space-y-1">
            <label className="label-xs">Category</label>
            <select value={form.category} onChange={set("category")} className="input-base">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="space-y-1">
            <label className="label-xs">Description</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={set("description")}
              className="input-base"
              style={{ height: "auto", resize: "vertical" }}
            />
          </div>
        </div>

        <div className="flex gap-2.5 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button variant="default" className="flex-1" onClick={() => onSave(event.id, form)} disabled={isPending}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_EVENT = {
  title: "", description: "", location: "", city: "", category: "other",
  date: "", end_date: "", image: "", gallery: "",
  source_url: "", booking_url: "", organizer: "", contact: "",
  is_paid: false, ticket_price: "", price_tier: "cheap",
  is_featured: false, trending: false, aiBoostScore: 50, adminPriority: 50,
  audience: [], budgetLevel: "all", eventType: "", recurring: false,
  tags: "", keywords: "", lat: "", lng: "",
};

const EVENT_AUDIENCE = ["students", "professionals", "families", "couples", "religious", "fitness", "nightlife", "productivity"];

/* ── Create Event Form ───────────────────────────────────────────────────── */
function CreateEventModal({ onClose, onSave, isPending }) {
  const [form, setForm] = useState(EMPTY_EVENT);
  const [tab, setTab] = useState("basic");
  const set = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const toggleAud = (a) => setForm((f) => ({
    ...f,
    audience: f.audience.includes(a) ? f.audience.filter((x) => x !== a) : [...f.audience, a],
  }));

  const handleSave = () => {
    onSave({
      ...form,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      keywords: form.keywords.split(",").map((t) => t.trim()).filter(Boolean),
      gallery: form.gallery.split("\n").map((u) => u.trim()).filter(Boolean),
      coordinates: form.lat && form.lng ? { lat: Number(form.lat), lng: Number(form.lng) } : null,
    });
  };

  const TABS = [
    { id: "basic", label: "Basic" },
    { id: "details", label: "Details" },
    { id: "location", label: "Location" },
    { id: "media", label: "Media" },
    { id: "boost", label: "AI Boost" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-2xl rounded-xl space-y-0 animate-fade-in max-h-[92vh] flex flex-col"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", boxShadow: "0 16px 48px rgba(0,0,0,0.14)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Create New Event</h2>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-overlay">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle overflow-x-auto px-4">
          {TABS.map(({ id, label }) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={`px-4 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === id ? "border-stone-800 text-text-primary" : "border-transparent text-text-tertiary hover:text-text-secondary"
              }`}
            >{label}</button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {tab === "basic" && (
            <>
              <div className="space-y-1">
                <label className="label-xs">Title *</label>
                <input className="input-base" value={form.title} onChange={set("title")} placeholder="Event name" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="label-xs">Category</label>
                  <select className="input-base" value={form.category} onChange={set("category")}>
                    {[...CATEGORIES, "festival", "nightlife"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Event Type</label>
                  <input className="input-base" value={form.eventType} onChange={set("eventType")} placeholder="conference, concert, workshop…" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="label-xs">Description</label>
                <textarea className="input-base" rows={4} style={{ height: "auto", resize: "vertical" }} value={form.description} onChange={set("description")} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="label-xs">Start Date/Time</label>
                  <input type="datetime-local" className="input-base" value={form.date} onChange={set("date")} />
                </div>
                <div className="space-y-1">
                  <label className="label-xs">End Date/Time</label>
                  <input type="datetime-local" className="input-base" value={form.end_date} onChange={set("end_date")} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={form.is_featured} onChange={set("is_featured")} className="h-3.5 w-3.5" />
                  Featured event
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={form.recurring} onChange={set("recurring")} className="h-3.5 w-3.5" />
                  Recurring event
                </label>
              </div>
            </>
          )}

          {tab === "details" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="label-xs">Organizer</label>
                  <input className="input-base" value={form.organizer} onChange={set("organizer")} placeholder="Organization name" />
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Contact</label>
                  <input className="input-base" value={form.contact} onChange={set("contact")} placeholder="email or phone" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="label-xs">Booking / Ticket URL</label>
                  <input className="input-base" value={form.booking_url} onChange={set("booking_url")} placeholder="https://…" />
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Source URL</label>
                  <input className="input-base" value={form.source_url} onChange={set("source_url")} placeholder="https://…" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="label-xs">Price Tier</label>
                  <select className="input-base" value={form.price_tier} onChange={set("price_tier")}>
                    <option value="cheap">Cheap / Free</option>
                    <option value="affordable">Affordable</option>
                    <option value="expensive">Expensive</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Ticket Price</label>
                  <input className="input-base" value={form.ticket_price} onChange={set("ticket_price")} placeholder="ETB 600" />
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Budget Level</label>
                  <select className="input-base" value={form.budgetLevel} onChange={set("budgetLevel")}>
                    <option value="all">All</option>
                    <option value="cheap">Cheap</option>
                    <option value="medium">Medium</option>
                    <option value="expensive">Expensive</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="label-xs">Tags (comma-separated)</label>
                <input className="input-base" value={form.tags} onChange={set("tags")} placeholder="outdoor, live-music, networking" />
              </div>
              <div className="space-y-1">
                <label className="label-xs">Keywords (comma-separated)</label>
                <input className="input-base" value={form.keywords} onChange={set("keywords")} placeholder="jazz, tech startup, family" />
              </div>
              <div className="space-y-2">
                <span className="label-xs">Target Audience</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {EVENT_AUDIENCE.map((a) => (
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
            </>
          )}

          {tab === "location" && (
            <>
              <div className="space-y-1">
                <label className="label-xs">Venue / Location Name</label>
                <input className="input-base" value={form.location} onChange={set("location")} placeholder="Skylight Hotel, Addis Ababa" />
              </div>
              <div className="space-y-1">
                <label className="label-xs">City</label>
                <input className="input-base" value={form.city} onChange={set("city")} placeholder="Addis Ababa" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="label-xs">Latitude</label>
                  <input type="number" step="any" className="input-base" value={form.lat} onChange={set("lat")} placeholder="9.0192" />
                </div>
                <div className="space-y-1">
                  <label className="label-xs">Longitude</label>
                  <input type="number" step="any" className="input-base" value={form.lng} onChange={set("lng")} placeholder="38.7525" />
                </div>
              </div>
            </>
          )}

          {tab === "media" && (
            <>
              <div className="space-y-1">
                <label className="label-xs">Thumbnail / Banner URL</label>
                <input className="input-base" value={form.image} onChange={set("image")} placeholder="https://…" />
                {form.image && (
                  <img src={form.image} alt="" className="mt-2 h-24 w-full rounded-lg object-cover border border-border"
                    onError={(e) => { e.target.style.display = "none"; }} />
                )}
              </div>
              <div className="space-y-1">
                <label className="label-xs">Gallery URLs (one per line)</label>
                <textarea className="input-base font-mono text-xs" rows={4} style={{ height: "auto" }}
                  value={form.gallery} onChange={set("gallery")}
                  placeholder={"https://example.com/img1.jpg\nhttps://example.com/img2.jpg"} />
              </div>
            </>
          )}

          {tab === "boost" && (
            <div className="space-y-5">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <strong>Note:</strong> Boosts apply AFTER personalization filters. A boosted nightlife event won't appear for users who have marked nightlife as disliked.
              </div>
              {[
                { label: "AI Boost Score", key: "aiBoostScore" },
                { label: "Admin Priority", key: "adminPriority" },
              ].map(({ label, key }) => (
                <div key={key} className="space-y-1">
                  <div className="flex justify-between">
                    <span className="label-xs">{label}</span>
                    <span className="text-xs font-semibold tabular-nums">{form[key]}/100</span>
                  </div>
                  <input type="range" min={0} max={100} step={5} value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
                    className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
                  />
                </div>
              ))}
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input type="checkbox" checked={form.trending} onChange={set("trending")} className="h-3.5 w-3.5" />
                Mark as Trending
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2.5 px-6 py-4 border-t border-border-subtle">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" disabled={isPending || !form.title.trim()} onClick={handleSave}>
            {isPending ? "Creating…" : "Create Event"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────────────────────── */
export default function EventsPage() {
  const qc = useQueryClient();
  const [editingEvent,    setEditingEvent]    = useState(null);
  const [showCreate,      setShowCreate]      = useState(false);
  const [categoryFilter,  setCategoryFilter]  = useState("all");
  const [search,          setSearch]          = useState("");
  const [page,            setPage]            = useState(1);
  const [boostingId,      setBoostingId]      = useState(null);
  const [boostForm,       setBoostForm]       = useState({ aiBoostScore: 50, adminPriority: 50 });
  const PAGE_SIZE = 20;

  const statsQuery = useQuery({ queryKey: ["events-stats"], queryFn: getEventsStats });
  const eventsQuery = useQuery({
    queryKey: ["admin-events", categoryFilter],
    queryFn: () => getAdminEvents({ category: categoryFilter === "all" ? undefined : categoryFilter, limit: 200 }),
  });

  const createMutation = useMutation({
    mutationFn: createAdminEvent,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-events"] }); setShowCreate(false); },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => updateAdminEvent(id, updates),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-events"] }); setEditingEvent(null); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => deleteAdminEvent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-events"] }),
  });
  const featuredMutation = useMutation({
    mutationFn: ({ id, featured }) => setEventFeatured(id, featured),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-events"] }),
  });
  const trendingMutation = useMutation({
    mutationFn: ({ id, trending }) => apiClient.patch(`/events/${id}/trending`, { trending }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-events"] }),
  });
  const boostMutation = useMutation({
    mutationFn: ({ id, boost }) => apiClient.patch(`/events/${id}/boost`, boost).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-events"] }); setBoostingId(null); },
  });

  const allEvents = eventsQuery.data?.events ?? [];
  const total     = statsQuery.data?.total ?? allEvents.length;

  const filtered = allEvents.filter((e) =>
    !search || e.title?.toLowerCase().includes(search.toLowerCase()) || e.location?.toLowerCase().includes(search.toLowerCase())
  );
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageStart   = (page - 1) * PAGE_SIZE;
  const pagedEvents = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const handleDelete = (id, title) => {
    if (!window.confirm(`Delete "${title}"?`)) return;
    deleteMutation.mutate(id);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Events</h2>
          <p className="page-sub">
            {total.toLocaleString()} events · {allEvents.filter((e) => e.is_featured || e.featured).length} featured · {allEvents.filter((e) => e.trending).length} trending
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary" size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["admin-events"] })}
            disabled={eventsQuery.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${eventsQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5" />
            Create Event
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-tertiary" />
          <input
            className="input-base pl-9 w-60"
            placeholder="Search events…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        {/* Category pills */}
        <div className="flex flex-wrap gap-1.5">
          {["all", ...CATEGORIES].map((cat) => (
            <button
              key={cat}
              onClick={() => { setCategoryFilter(cat); setPage(1); }}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors border",
                categoryFilter === cat
                  ? "bg-text-primary text-white border-text-primary"
                  : "bg-white text-text-secondary border-border hover:border-border-strong hover:text-text-primary"
              )}
            >
              {cat === "all" ? "All" : cat}
            </button>
          ))}
        </div>
      </div>

      {eventsQuery.isError && <Alert variant="error">{eventsQuery.error?.message}</Alert>}

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                {["Event", "Category", "Date", "Location", "Source", "★ Feat", "🔥 Trend", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left" style={{ background: "var(--color-surface-overlay)" }}>
                    <span className="label-xs">{h}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {eventsQuery.isLoading
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={8} />)
                : pagedEvents.length === 0
                ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-text-tertiary">
                        <CalendarDays className="h-8 w-8 opacity-40" />
                        <p className="text-sm">No events found</p>
                      </div>
                    </td>
                  </tr>
                )
                : pagedEvents.map((event) => (
                  <>
                  <tr
                    key={event.id}
                    className="table-row-hover"
                    style={{ borderBottom: "1px solid var(--color-border-subtle)" }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {event.image ? (
                          <img
                            src={event.image}
                            alt=""
                            className="h-8 w-12 rounded-md object-cover shrink-0"
                            style={{ background: "var(--color-surface-overlay)" }}
                            onError={(e) => { e.target.style.display = "none"; }}
                          />
                        ) : (
                          <div
                            className="h-8 w-12 rounded-md shrink-0 flex items-center justify-center"
                            style={{ background: "var(--color-surface-inset)" }}
                          >
                            <CalendarDays className="h-3.5 w-3.5 text-text-tertiary" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-text-primary truncate max-w-[220px]">{event.title}</p>
                          {event.source_url && (
                            <a
                              href={event.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-text-tertiary hover:text-text-secondary hover:underline transition-colors"
                            >
                              View source ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="default">{event.category || "other"}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary">{fmtDate(event.date)}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary max-w-[140px] truncate">{event.location || "—"}</td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] text-text-tertiary bg-surface-overlay border border-border rounded px-1.5 py-0.5">
                        {SOURCE_LABELS[event.source] || event.source || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => featuredMutation.mutate({ id: event.id, featured: !(event.is_featured || event.featured) })}
                        className={cn("transition-colors", (event.is_featured || event.featured) ? "text-warn" : "text-text-tertiary hover:text-warn")}
                        title={(event.is_featured || event.featured) ? "Unfeature" : "Mark as featured"}
                      >
                        <Star className="h-3.5 w-3.5" fill={(event.is_featured || event.featured) ? "currentColor" : "none"} />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => trendingMutation.mutate({ id: event.id, trending: !event.trending })}
                        className={cn("transition-colors", event.trending ? "text-orange-500" : "text-text-tertiary hover:text-orange-400")}
                        title={event.trending ? "Remove trending" : "Mark as trending"}
                      >
                        <Flame className="h-3.5 w-3.5" fill={event.trending ? "currentColor" : "none"} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <Button variant="ghost" size="xs" onClick={() => {
                          if (boostingId === event.id) { setBoostingId(null); return; }
                          setBoostForm({ aiBoostScore: event.aiBoostScore ?? 50, adminPriority: event.adminPriority ?? 50 });
                          setBoostingId(event.id);
                        }}>
                          <Zap className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setEditingEvent(event)}>Edit</Button>
                        <Button variant="ghost" size="xs" className="text-negative hover:bg-[#fef2f2]"
                          onClick={() => handleDelete(event.id, event.title)} disabled={deleteMutation.isPending}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {boostingId === event.id && (
                    <tr key={`boost-${event.id}`} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                      <td colSpan={8} className="px-4 pb-3">
                        <div className="rounded-lg border border-border-subtle bg-surface-overlay p-3 space-y-3">
                          <p className="text-xs font-medium text-text-primary">Quick Boost — {event.title}</p>
                          <div className="grid gap-4 sm:grid-cols-2">
                            {[["aiBoostScore","AI Boost Score"],["adminPriority","Admin Priority"]].map(([k,l]) => (
                              <div key={k} className="space-y-1">
                                <div className="flex justify-between"><span className="label-xs">{l}</span><span className="text-xs font-semibold tabular-nums">{boostForm[k]}</span></div>
                                <input type="range" min={0} max={100} step={5} value={boostForm[k]}
                                  onChange={(e) => setBoostForm((f) => ({ ...f, [k]: Number(e.target.value) }))}
                                  className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
                                />
                              </div>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={boostMutation.isPending}
                              onClick={() => boostMutation.mutate({ id: event.id, boost: boostForm })}>
                              {boostMutation.isPending ? "Saving…" : "Apply Boost"}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setBoostingId(null)}>Cancel</Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </>
                ))
              }
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: "1px solid var(--color-border-subtle)" }}
          >
            <p className="text-xs text-text-tertiary">
              {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-text-secondary tabular-nums">{page} / {totalPages}</span>
              <Button variant="secondary" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {editingEvent && (
        <EditModal
          event={editingEvent}
          onClose={() => setEditingEvent(null)}
          onSave={(id, updates) => updateMutation.mutate({ id, updates })}
          isPending={updateMutation.isPending}
        />
      )}
      {showCreate && (
        <CreateEventModal
          onClose={() => setShowCreate(false)}
          onSave={(data) => createMutation.mutate(data)}
          isPending={createMutation.isPending}
        />
      )}
      {createMutation.isError && <div className="text-xs text-red-600">{createMutation.error?.message}</div>}
    </div>
  );
}
