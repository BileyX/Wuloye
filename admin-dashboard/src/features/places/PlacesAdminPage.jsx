import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, RefreshCw, X, Zap, Star } from "lucide-react";
import {
  createAdminPlace,
  deleteAdminPlace,
  getAdminPlaces,
  updateAdminPlace,
} from "@/services/endpoints";
import { apiClient } from "@/services/apiClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { LoadingState, SkeletonRow } from "@/components/ui/loading";

const TYPES  = "gym,coffee,restaurant,park,yoga,social,walk,study,outdoor,hotel,church,sports".split(",");
const PRICES = ["free", "low", "medium", "high"];

function Field({ label, children, className }) {
  return (
    <label className={`block space-y-1 ${className ?? ""}`}>
      <span className="label-xs">{label}</span>
      {children}
    </label>
  );
}

export default function PlacesAdminPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "", category: "restaurant", priceRange: "medium",
    city: "", description: "", featured: false, trending: false, disabled: false,
    priceClassificationOverrideNote: "",
  });

  const placesQuery = useQuery({
    queryKey: ["admin-places"],
    queryFn: getAdminPlaces,
  });

  const createMut = useMutation({
    mutationFn: () => createAdminPlace({
      name: form.name.trim(), type: form.category,
      priceRange: form.priceRange, location: { city: form.city.trim() },
      description: form.description.trim(), featured: form.featured,
      trending: form.trending, disabled: form.disabled, images: [], tags: [],
      priceClassificationOverrideNote: form.priceClassificationOverrideNote.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-places"] });
      setForm((f) => ({ ...f, name: "", description: "" }));
      setShowForm(false);
    },
  });

  const patchMut = useMutation({
    mutationFn: ({ id, patch }) => updateAdminPlace(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-places"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id) => deleteAdminPlace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-places"] }),
  });
  const boostMut = useMutation({
    mutationFn: ({ id, boost }) =>
      apiClient.patch(`/admin/places/${id}/boost`, boost).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-places"] }),
  });

  const [boostingId, setBoostingId] = useState(null);
  const [boostForm, setBoostForm]   = useState({ aiBoostScore: 50, adminPriority: 50 });

  const places = placesQuery.data?.data ?? [];
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: typeof f[k] === "boolean"
        ? e.target.type === "checkbox" ? e.target.checked : f[k]
        : e.target.value,
    }));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Places Catalogue</h2>
          <p className="page-sub">Firestore-backed destinations powering personalised recommendations</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["admin-places"] })}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-3.5 w-3.5" />
            Add place
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Place</CardTitle>
            <button type="button" onClick={() => setShowForm(false)} className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-overlay transition-colors">
              <X className="h-4 w-4" />
            </button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Name">
                <input className="input-base" value={form.name} onChange={set("name")} placeholder="Downtown Bistro" />
              </Field>
              <Field label="Category / type">
                <select className="input-base" value={form.category} onChange={set("category")}>
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Price range">
                <select className="input-base" value={form.priceRange} onChange={set("priceRange")}>
                  {PRICES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="City">
                <input className="input-base" value={form.city} onChange={set("city")} placeholder="Addis Ababa" />
              </Field>
              <Field label="Override note" className="md:col-span-2">
                <input className="input-base" value={form.priceClassificationOverrideNote} onChange={set("priceClassificationOverrideNote")} placeholder="Why price band was forced" />
              </Field>
              <Field label="Description" className="md:col-span-2">
                <textarea className="input-base" rows={3} style={{ height: "auto", resize: "vertical" }} value={form.description} onChange={set("description")} />
              </Field>
              <div className="md:col-span-2 flex flex-wrap gap-4">
                {[
                  { key: "featured", label: "Featured catalogue pick" },
                  { key: "trending", label: "Trending signal" },
                  { key: "disabled", label: "Disabled / broken venue" },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4 flex gap-2.5">
              <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button disabled={createMut.isPending || !form.name.trim()} onClick={() => createMut.mutate()}>
                {createMut.isPending ? "Creating…" : "Publish place"}
              </Button>
            </div>
            {createMut.isError && <Alert variant="error" className="mt-3">{createMut.error?.message}</Alert>}
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle>Catalogue ({places.length})</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                {["Place", "Type", "Price", "City", "AI Boost", "Flags", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left" style={{ background: "var(--color-surface-overlay)" }}>
                    <span className="label-xs">{h}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {placesQuery.isLoading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={6} />)
                : places.length === 0
                ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-text-tertiary">
                        <MapPin className="h-8 w-8 opacity-40" />
                        <p className="text-sm">No places yet</p>
                      </div>
                    </td>
                  </tr>
                )
                : places.map((p) => (
                  <>
                  <tr key={p.id} className="table-row-hover" style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                    <td className="px-4 py-3 text-xs font-medium text-text-primary">{p.name}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary capitalize">{p.type}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary capitalize">{p.priceRange ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary">{p.location?.city ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <div className="h-1.5 w-20 rounded-full bg-border overflow-hidden">
                          <div className="h-full rounded-full bg-stone-800" style={{ width: `${p.aiBoostScore ?? 0}%` }} />
                        </div>
                        <span className="text-[10px] text-text-tertiary tabular-nums">{p.aiBoostScore ?? 0}/100</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {p.featured && <Badge variant="success">Featured</Badge>}
                        {p.trending && <Badge variant="warning">Trending</Badge>}
                        {p.disabled && <Badge variant="danger">Disabled</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <Button
                          variant="ghost" size="xs"
                          onClick={() => {
                            if (boostingId === p.id) { setBoostingId(null); return; }
                            setBoostForm({ aiBoostScore: p.aiBoostScore ?? 50, adminPriority: p.adminPriority ?? 50 });
                            setBoostingId(p.id);
                          }}
                        >
                          <Zap className="h-3 w-3" />
                          Boost
                        </Button>
                        <Button
                          variant="ghost" size="xs"
                          onClick={() => patchMut.mutate({ id: p.id, patch: { featured: !Boolean(p.featured) } })}
                          disabled={patchMut.isPending}
                        >
                          <Star className={`h-3 w-3 ${p.featured ? "fill-amber-500 text-amber-500" : ""}`} />
                          {p.featured ? "Unfeature" : "Feature"}
                        </Button>
                        <Button
                          variant="ghost" size="xs"
                          onClick={() => patchMut.mutate({ id: p.id, patch: { disabled: !Boolean(p.disabled) } })}
                          disabled={patchMut.isPending}
                        >
                          {p.disabled ? "Enable" : "Disable"}
                        </Button>
                        <Button
                          variant="ghost" size="xs"
                          className="text-negative hover:bg-[#fef2f2]"
                          disabled={deleteMut.isPending}
                          onClick={() => { if (window.confirm(`Delete ${p.name}?`)) deleteMut.mutate(p.id); }}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {boostingId === p.id && (
                    <tr key={`boost-${p.id}`} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                      <td colSpan={7} className="px-4 pb-3">
                        <div className="rounded-lg border border-border-subtle bg-surface-overlay p-3 space-y-3">
                          <p className="text-xs font-medium text-text-primary">Quick Boost — {p.name}</p>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-1">
                              <div className="flex justify-between">
                                <span className="label-xs">AI Boost Score</span>
                                <span className="text-xs font-semibold tabular-nums">{boostForm.aiBoostScore}</span>
                              </div>
                              <input type="range" min={0} max={100} step={5} value={boostForm.aiBoostScore}
                                onChange={(e) => setBoostForm((f) => ({ ...f, aiBoostScore: Number(e.target.value) }))}
                                className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between">
                                <span className="label-xs">Admin Priority</span>
                                <span className="text-xs font-semibold tabular-nums">{boostForm.adminPriority}</span>
                              </div>
                              <input type="range" min={0} max={100} step={5} value={boostForm.adminPriority}
                                onChange={(e) => setBoostForm((f) => ({ ...f, adminPriority: Number(e.target.value) }))}
                                className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
                              />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={boostMut.isPending}
                              onClick={() => { boostMut.mutate({ id: p.id, boost: boostForm }); setBoostingId(null); }}
                            >
                              {boostMut.isPending ? "Saving…" : "Apply Boost"}
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
      </Card>

      {placesQuery.isError && <Alert variant="error">{placesQuery.error?.message || "Failed to load places"}</Alert>}
    </div>
  );
}
