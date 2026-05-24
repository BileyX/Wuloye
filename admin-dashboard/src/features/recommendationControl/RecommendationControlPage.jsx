import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Sparkles, Plus, RefreshCw, X, Star, TrendingUp, Zap, Eye, Heart,
  BookmarkCheck, Ban, ChevronDown, ChevronUp, MapPin, DollarSign,
  Image, Settings2, BarChart3, Filter, Flame, Crown,
} from "lucide-react";
import {
  getAdminRecommendationControl,
  createAdminRecommendation,
  updateAdminRecommendation,
  deleteAdminRecommendation,
  boostAdminRecommendation,
  featureAdminRecommendation,
  getAdminRecommendationAnalytics,
} from "@/services/endpoints";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { LoadingState, SkeletonCard } from "@/components/ui/loading";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  "cafe", "restaurant", "gym", "hotel", "church", "mosque", "events",
  "workspace", "lounge", "sports", "entertainment", "travel", "park",
  "yoga", "shopping", "outdoor", "social",
];

const BUDGET_TIERS = [
  { value: "cheap",   label: "Cheap",    color: "bg-emerald-100 text-emerald-800" },
  { value: "medium",  label: "Medium",   color: "bg-yellow-100 text-yellow-800" },
  { value: "expensive", label: "Expensive", color: "bg-red-100 text-red-800" },
  { value: "flexible", label: "Flexible", color: "bg-purple-100 text-purple-800" },
];

const LIFESTYLE_TYPES = [
  "active", "relaxed", "social", "professional", "student", "family", "spiritual",
];

const AUDIENCE_TAGS = [
  "family", "students", "professionals", "couples", "groups", "solo", "seniors",
];

const EMPTY_FORM = {
  name: "", description: "", category: "cafe", subcategory: "",
  tags: "", keywords: "", audience: [], lifestyleType: "", quietSocialLevel: "medium",
  indoorOutdoor: "indoor", familyFriendly: false, studentFriendly: false, professionalFriendly: false,
  budgetTier: "medium",
  estimatedMealCost: "", estimatedDrinkCost: "", estimatedAvgSpend: "",
  estimatedTicketCost: "", estimatedGymCost: "", estimatedEventCost: "",
  address: "", lat: "", lng: "", googleMapsUrl: "", googlePlaceId: "",
  nearbyLandmarks: "", areaName: "", city: "", region: "",
  thumbnailUrl: "", coverUrl: "", galleryUrls: "",
  aiBoostScore: 50, adminPriority: 50,
  featured: false, trending: false, eventBoost: false, seasonalBoost: false, sponsored: false,
  // Targeting criteria
  targetReligion: [], targetGender: [], targetBudgetTier: [], targetAudience: [],
  onboardingMatchCriteria: {},
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, iconColor = "text-text-secondary" }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="label-xs mb-1.5">{label}</p>
            <p className="text-2xl font-semibold text-text-primary tabular-nums" style={{ letterSpacing: "-0.02em" }}>
              {value}
            </p>
            {sub && <p className="text-[11px] text-text-tertiary mt-0.5">{sub}</p>}
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-overlay border border-border-subtle">
            <Icon className={`h-4 w-4 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BadgePill({ label, variant = "default", className = "" }) {
  const colors = {
    featured:  "bg-amber-100 text-amber-800 border-amber-200",
    trending:  "bg-orange-100 text-orange-800 border-orange-200",
    sponsored: "bg-purple-100 text-purple-800 border-purple-200",
    default:   "bg-surface-overlay text-text-secondary border-border",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${colors[variant] ?? colors.default} ${className}`}>
      {label}
    </span>
  );
}

function BoostSlider({ label, value, onChange, max = 100 }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="label-xs">{label}</span>
        <span className="text-xs font-semibold text-text-primary tabular-nums">{value}</span>
      </div>
      <input
        type="range" min={0} max={max} step={5} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full accent-stone-800 cursor-pointer"
      />
      <div className="flex justify-between text-[9px] text-text-tertiary">
        <span>Low</span><span>High</span>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <div
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-4.5 w-8 flex-shrink-0 rounded-full border transition-colors cursor-pointer ${
          checked ? "bg-stone-800 border-stone-800" : "bg-surface-overlay border-border"
        }`}
        style={{ height: "18px", width: "32px" }}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-3.5" : ""}`}
          style={{ height: "14px", width: "14px" }}
        />
      </div>
      <div>
        <p className="text-xs font-medium text-text-primary">{label}</p>
        {description && <p className="text-[10px] text-text-tertiary">{description}</p>}
      </div>
    </label>
  );
}

function SectionHeader({ title, description }) {
  return (
    <div className="border-b border-border-subtle pb-2 mb-4">
      <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
      {description && <p className="text-xs text-text-tertiary mt-0.5">{description}</p>}
    </div>
  );
}

function AnalyticsBar({ data }) {
  const max = Math.max(...data.map((d) => d.engagementScore), 1);
  return (
    <div className="space-y-2">
      {data.slice(0, 10).map((item) => (
        <div key={item.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs font-medium text-text-primary truncate">{item.name}</span>
              <span className="text-[10px] text-text-tertiary ml-2 whitespace-nowrap">{item.ctr}% CTR</span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
              <div
                className="h-full rounded-full bg-stone-800 transition-all"
                style={{ width: `${Math.round((item.engagementScore / max) * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex gap-1 text-[10px] text-text-tertiary shrink-0">
            <span title="Likes">♥ {item.likes}</span>
            <span title="Saves">⊕ {item.saves}</span>
            <span title="Dismisses">✕ {item.dismisses}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Create / Edit Form ───────────────────────────────────────────────────────

function RecommendationForm({ initial, onSubmit, onCancel, isPending }) {
  const initForm = initial
    ? {
        ...EMPTY_FORM, ...initial,
        // Unpack targeting criteria stored in onboardingMatchCriteria
        targetReligion:   initial.onboardingMatchCriteria?.religion   ?? [],
        targetGender:     initial.onboardingMatchCriteria?.gender     ?? [],
        targetBudgetTier: initial.onboardingMatchCriteria?.budgetTier ?? [],
        targetAudience:   initial.audienceTags ?? [],
        tags:       Array.isArray(initial.tags)       ? initial.tags.join(", ")      : (initial.tags ?? ""),
        keywords:   Array.isArray(initial.keywords)   ? initial.keywords.join(", ")  : (initial.keywords ?? ""),
        galleryUrls: Array.isArray(initial.gallery)   ? initial.gallery.join("\n")   : (initial.galleryUrls ?? ""),
      }
    : EMPTY_FORM;
  const [form, setForm] = useState(initForm);
  const [section, setSection] = useState("basic");
  const set = (key) => (val) => setForm((f) => ({ ...f, [key]: val }));
  const setE = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggle = (key) => () => setForm((f) => ({ ...f, [key]: !f[key] }));
  const toggleAudience = (tag) =>
    setForm((f) => ({
      ...f,
      audience: f.audience.includes(tag) ? f.audience.filter((t) => t !== tag) : [...f.audience, tag],
    }));

  const SECTIONS = [
    { id: "basic",    label: "Basic Info",   icon: Settings2 },
    { id: "budget",   label: "Budget",       icon: DollarSign },
    { id: "location", label: "Location",     icon: MapPin },
    { id: "media",    label: "Media",        icon: Image },
    { id: "ai",       label: "AI Controls",  icon: Sparkles },
  ];

  const handleSubmit = () => {
    const tags     = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const keywords = form.keywords.split(",").map((k) => k.trim()).filter(Boolean);
    const gallery  = form.galleryUrls.split("\n").map((u) => u.trim()).filter(Boolean);
    // Build the targeting criteria object consumed by the AI scoring engine
    const onboardingMatchCriteria = {};
    if ((form.targetReligion ?? []).length > 0)   onboardingMatchCriteria.religion   = form.targetReligion;
    if ((form.targetGender ?? []).length > 0)      onboardingMatchCriteria.gender     = form.targetGender;
    if ((form.targetBudgetTier ?? []).length > 0)  onboardingMatchCriteria.budgetTier = form.targetBudgetTier;

    onSubmit({
      ...form, tags, keywords, gallery,
      audienceTags: form.targetAudience ?? [],
      onboardingMatchCriteria,
      location: {
        address: form.address, lat: form.lat ? Number(form.lat) : null,
        lng: form.lng ? Number(form.lng) : null,
        nearbyLandmarks: form.nearbyLandmarks, areaName: form.areaName,
        city: form.city, region: form.region,
      },
      estimatedCost: {
        meal: form.estimatedMealCost || null, drink: form.estimatedDrinkCost || null,
        avgSpend: form.estimatedAvgSpend || null, ticket: form.estimatedTicketCost || null,
        gym: form.estimatedGymCost || null, event: form.estimatedEventCost || null,
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? "Edit Recommendation" : "Add New Recommendation"}</CardTitle>
        <button type="button" onClick={onCancel} className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-overlay">
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent>
        {/* Section tabs */}
        <div className="flex gap-1 mb-6 border-b border-border-subtle pb-0 overflow-x-auto">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                section === id
                  ? "border-stone-800 text-text-primary"
                  : "border-transparent text-text-tertiary hover:text-text-secondary"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* ── Basic Info ── */}
        {section === "basic" && (
          <div className="space-y-4">
            <SectionHeader title="Basic Information" description="Core details about this recommendation" />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Place Name *</span>
                <input className="input-base" placeholder="e.g. Tomoca Coffee" value={form.name} onChange={setE("name")} />
              </label>
              <label className="block space-y-1">
                <span className="label-xs">Category *</span>
                <select className="input-base" value={form.category} onChange={setE("category")}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="label-xs">Description</span>
              <textarea className="input-base" rows={3} placeholder="Describe this place..." value={form.description} onChange={setE("description")} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Subcategory</span>
                <input className="input-base" placeholder="e.g. Specialty Coffee" value={form.subcategory} onChange={setE("subcategory")} />
              </label>
              <label className="block space-y-1">
                <span className="label-xs">Lifestyle Type</span>
                <select className="input-base" value={form.lifestyleType} onChange={setE("lifestyleType")}>
                  <option value="">Select...</option>
                  {LIFESTYLE_TYPES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Indoor / Outdoor</span>
                <select className="input-base" value={form.indoorOutdoor} onChange={setE("indoorOutdoor")}>
                  <option value="indoor">Indoor</option>
                  <option value="outdoor">Outdoor</option>
                  <option value="both">Both</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="label-xs">Quiet / Social Level</span>
                <select className="input-base" value={form.quietSocialLevel} onChange={setE("quietSocialLevel")}>
                  <option value="quiet">Quiet</option>
                  <option value="moderate">Moderate</option>
                  <option value="social">Social / Lively</option>
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="label-xs">Tags (comma-separated)</span>
              <input className="input-base" placeholder="wifi, quiet, terrace, pet-friendly" value={form.tags} onChange={setE("tags")} />
            </label>
            <label className="block space-y-1">
              <span className="label-xs">Keywords (comma-separated)</span>
              <input className="input-base" placeholder="study spot, coffee, remote work" value={form.keywords} onChange={setE("keywords")} />
            </label>
            <div className="space-y-2">
              <span className="label-xs">Recommended Audience</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {AUDIENCE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleAudience(tag)}
                    className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors ${
                      form.audience.includes(tag)
                        ? "bg-stone-800 text-white border-stone-800"
                        : "bg-white text-text-secondary border-border hover:border-stone-400"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Toggle label="Family Friendly" checked={form.familyFriendly} onChange={toggle("familyFriendly")} />
              <Toggle label="Student Friendly" checked={form.studentFriendly} onChange={toggle("studentFriendly")} />
              <Toggle label="Professional" checked={form.professionalFriendly} onChange={toggle("professionalFriendly")} />
            </div>
          </div>
        )}

        {/* ── Budget ── */}
        {section === "budget" && (
          <div className="space-y-4">
            <SectionHeader title="Budget Information" description="Help the AI match this place to appropriate users" />
            <div className="space-y-2">
              <span className="label-xs">Budget Tier</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {BUDGET_TIERS.map(({ value, label, color }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, budgetTier: value }))}
                    className={`text-xs px-4 py-2 rounded-full border font-medium transition-colors ${
                      form.budgetTier === value
                        ? "bg-stone-800 text-white border-stone-800"
                        : "bg-white text-text-secondary border-border hover:border-stone-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ["estimatedMealCost", "Est. Meal Cost (ETB)"],
                ["estimatedDrinkCost", "Est. Drink Cost (ETB)"],
                ["estimatedAvgSpend", "Avg. Spending / Visit (ETB)"],
                ["estimatedTicketCost", "Ticket / Entry Cost (ETB)"],
                ["estimatedGymCost", "Gym Membership / Month (ETB)"],
                ["estimatedEventCost", "Event Pricing (ETB)"],
              ].map(([key, label]) => (
                <label key={key} className="block space-y-1">
                  <span className="label-xs">{label}</span>
                  <input
                    type="number" className="input-base" placeholder="0"
                    value={form[key]} onChange={setE(key)}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* ── Location ── */}
        {section === "location" && (
          <div className="space-y-4">
            <SectionHeader title="Location Information" description="Used for distance calculations and Google Maps integration" />
            <label className="block space-y-1">
              <span className="label-xs">Full Address</span>
              <input className="input-base" placeholder="Bole Road, Addis Ababa" value={form.address} onChange={setE("address")} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Latitude</span>
                <input type="number" step="any" className="input-base" placeholder="9.0192" value={form.lat} onChange={setE("lat")} />
              </label>
              <label className="block space-y-1">
                <span className="label-xs">Longitude</span>
                <input type="number" step="any" className="input-base" placeholder="38.7525" value={form.lng} onChange={setE("lng")} />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="label-xs">Google Maps URL</span>
              <input className="input-base" placeholder="https://maps.google.com/..." value={form.googleMapsUrl} onChange={setE("googleMapsUrl")} />
            </label>
            <label className="block space-y-1">
              <span className="label-xs">Google Place ID</span>
              <input className="input-base" placeholder="ChIJN1t_tDeuEmsRUsoyG83frY4" value={form.googlePlaceId} onChange={setE("googlePlaceId")} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Area Name</span>
                <input className="input-base" placeholder="Bole" value={form.areaName} onChange={setE("areaName")} />
              </label>
              <label className="block space-y-1">
                <span className="label-xs">City</span>
                <input className="input-base" placeholder="Addis Ababa" value={form.city} onChange={setE("city")} />
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="label-xs">Region</span>
                <input className="input-base" placeholder="Addis Ababa" value={form.region} onChange={setE("region")} />
              </label>
              <label className="block space-y-1">
                <span className="label-xs">Nearby Landmarks</span>
                <input className="input-base" placeholder="Near Edna Mall" value={form.nearbyLandmarks} onChange={setE("nearbyLandmarks")} />
              </label>
            </div>
          </div>
        )}

        {/* ── Media ── */}
        {section === "media" && (
          <div className="space-y-4">
            <SectionHeader title="Media" description="Images shown on mobile recommendation cards" />
            <label className="block space-y-1">
              <span className="label-xs">Thumbnail URL</span>
              <input className="input-base" placeholder="https://..." value={form.thumbnailUrl} onChange={setE("thumbnailUrl")} />
              {form.thumbnailUrl && (
                <img src={form.thumbnailUrl} alt="thumb" className="mt-2 h-20 w-20 rounded-lg object-cover border border-border" onError={(e) => { e.target.style.display = "none"; }} />
              )}
            </label>
            <label className="block space-y-1">
              <span className="label-xs">Cover Image URL</span>
              <input className="input-base" placeholder="https://..." value={form.coverUrl} onChange={setE("coverUrl")} />
              {form.coverUrl && (
                <img src={form.coverUrl} alt="cover" className="mt-2 h-32 w-full rounded-lg object-cover border border-border" onError={(e) => { e.target.style.display = "none"; }} />
              )}
            </label>
            <label className="block space-y-1">
              <span className="label-xs">Gallery URLs (one per line)</span>
              <textarea
                className="input-base font-mono text-xs" rows={5}
                placeholder={"https://example.com/img1.jpg\nhttps://example.com/img2.jpg"}
                value={form.galleryUrls} onChange={setE("galleryUrls")}
              />
            </label>
          </div>
        )}

        {/* ── Targeting ── */}
        {section === "ai" && (
          <div className="space-y-6">
            <SectionHeader title="Audience Targeting" description="Define which users should see this recommendation boosted (leave blank for all)" />
            <div className="grid gap-5 sm:grid-cols-2">
              {/* Religion */}
              <div className="space-y-2">
                <span className="label-xs">Target Religion</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {["Orthodox", "Protestant", "Muslim", "Catholic", "Other"].map((r) => (
                    <button key={r} type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        targetReligion: f.targetReligion.includes(r)
                          ? f.targetReligion.filter((x) => x !== r)
                          : [...f.targetReligion, r],
                      }))}
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
                        (form.targetReligion ?? []).includes(r)
                          ? "bg-stone-800 text-white border-stone-800"
                          : "bg-white text-text-secondary border-border hover:border-stone-400"
                      }`}
                    >{r}</button>
                  ))}
                </div>
                <p className="text-[10px] text-text-tertiary">Blank = show to all religions</p>
              </div>

              {/* Gender */}
              <div className="space-y-2">
                <span className="label-xs">Target Gender</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {["male", "female"].map((g) => (
                    <button key={g} type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        targetGender: f.targetGender.includes(g)
                          ? f.targetGender.filter((x) => x !== g)
                          : [...f.targetGender, g],
                      }))}
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors capitalize ${
                        (form.targetGender ?? []).includes(g)
                          ? "bg-stone-800 text-white border-stone-800"
                          : "bg-white text-text-secondary border-border hover:border-stone-400"
                      }`}
                    >{g}</button>
                  ))}
                </div>
                <p className="text-[10px] text-text-tertiary">Blank = show to all genders</p>
              </div>

              {/* Budget */}
              <div className="space-y-2">
                <span className="label-xs">Target Budget Tier</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {["cheap", "medium", "expensive"].map((b) => (
                    <button key={b} type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        targetBudgetTier: f.targetBudgetTier.includes(b)
                          ? f.targetBudgetTier.filter((x) => x !== b)
                          : [...f.targetBudgetTier, b],
                      }))}
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors capitalize ${
                        (form.targetBudgetTier ?? []).includes(b)
                          ? "bg-stone-800 text-white border-stone-800"
                          : "bg-white text-text-secondary border-border hover:border-stone-400"
                      }`}
                    >{b}</button>
                  ))}
                </div>
                <p className="text-[10px] text-text-tertiary">Blank = show to all budgets</p>
              </div>

              {/* Audience */}
              <div className="space-y-2">
                <span className="label-xs">Target Audience Tags</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {["students","professionals","families","couples","religious","fitness","nightlife","productivity"].map((a) => (
                    <button key={a} type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        targetAudience: (f.targetAudience ?? []).includes(a)
                          ? (f.targetAudience ?? []).filter((x) => x !== a)
                          : [...(f.targetAudience ?? []), a],
                      }))}
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
                        (form.targetAudience ?? []).includes(a)
                          ? "bg-stone-800 text-white border-stone-800"
                          : "bg-white text-text-secondary border-border hover:border-stone-400"
                      }`}
                    >{a}</button>
                  ))}
                </div>
                <p className="text-[10px] text-text-tertiary">AI matches user interests/activities against these</p>
              </div>
            </div>
          </div>
        )}

        {/* ── AI Controls ── */}
        {section === "ai" && (
          <div className="space-y-6 border-t border-border-subtle pt-6">
            <SectionHeader title="AI Priority Controls" description="Influence how this place appears in the recommendation engine" />
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <strong>Important:</strong> Admin boosts are applied AFTER personalization filters. A luxury hotel will still never appear for users with cheap budgets, even at max boost.
            </div>
            <div className="space-y-5">
              <BoostSlider
                label="AI Boost Score (0 = no boost, 100 = max priority)"
                value={form.aiBoostScore}
                onChange={set("aiBoostScore")}
              />
              <BoostSlider
                label="Admin Priority (internal ranking weight)"
                value={form.adminPriority}
                onChange={set("adminPriority")}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Toggle
                label="Featured Recommendation"
                description="Pinned to top of eligible feeds"
                checked={form.featured}
                onChange={toggle("featured")}
              />
              <Toggle
                label="Trending"
                description="Shows trending badge on mobile"
                checked={form.trending}
                onChange={toggle("trending")}
              />
              <Toggle
                label="Event Boost"
                description="Boost during active events"
                checked={form.eventBoost}
                onChange={toggle("eventBoost")}
              />
              <Toggle
                label="Seasonal Boost"
                description="Temporarily boosted for a season"
                checked={form.seasonalBoost}
                onChange={toggle("seasonalBoost")}
              />
              <Toggle
                label="Sponsored"
                description="Marked as sponsored on mobile"
                checked={form.sponsored}
                onChange={toggle("sponsored")}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-6 mt-6 border-t border-border-subtle">
          <Button variant="secondary" onClick={onCancel} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending || !form.name.trim() || !form.category}>
            <Sparkles className="h-3.5 w-3.5" />
            {isPending ? "Saving…" : initial ? "Update" : "Create Recommendation"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Recommendation Card ──────────────────────────────────────────────────────

function RecommendationCard({ rec, onEdit, onDelete, onBoost, onFeature, isMutating }) {
  const [showBoost, setShowBoost] = useState(false);
  const [boost, setBoost] = useState({ aiBoostScore: rec.aiBoostScore ?? 50, adminPriority: rec.adminPriority ?? 50 });

  const budgetColor = {
    cheap: "bg-emerald-100 text-emerald-800",
    medium: "bg-yellow-100 text-yellow-800",
    expensive: "bg-red-100 text-red-800",
    flexible: "bg-purple-100 text-purple-800",
  }[rec.budgetTier] ?? "bg-surface-overlay text-text-secondary";

  return (
    <Card className="relative overflow-hidden">
      {/* Thumbnail stripe */}
      {rec.thumbnailUrl && (
        <div className="h-28 w-full overflow-hidden border-b border-border-subtle">
          <img src={rec.thumbnailUrl} alt={rec.name} className="h-full w-full object-cover" onError={(e) => { e.target.parentElement.style.display = "none"; }} />
        </div>
      )}

      <CardContent className="pt-4 pb-3">
        {/* Badges row */}
        <div className="flex flex-wrap gap-1 mb-2">
          {rec.featured  && <BadgePill label="★ Featured"  variant="featured" />}
          {rec.trending  && <BadgePill label="↑ Trending"  variant="trending" />}
          {rec.sponsored && <BadgePill label="Sponsored"   variant="sponsored" />}
          <BadgePill label={rec.category} />
          {rec.budgetTier && <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${budgetColor}`}>{rec.budgetTier}</span>}
        </div>

        <h3 className="text-sm font-semibold text-text-primary mb-0.5">{rec.name}</h3>
        {rec.description && <p className="text-xs text-text-tertiary line-clamp-2 mb-2">{rec.description}</p>}

        {/* Location */}
        {rec.location?.city && (
          <div className="flex items-center gap-1 text-[11px] text-text-tertiary mb-2">
            <MapPin className="h-3 w-3" />
            {[rec.location.areaName, rec.location.city].filter(Boolean).join(", ")}
          </div>
        )}

        {/* Boost meters */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-md bg-surface-overlay border border-border-subtle px-2.5 py-1.5">
            <div className="text-[10px] text-text-tertiary mb-1">AI Boost</div>
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-stone-800" style={{ width: `${rec.aiBoostScore ?? 0}%` }} />
            </div>
            <div className="text-[10px] text-text-primary font-medium mt-0.5 tabular-nums">{rec.aiBoostScore ?? 0}/100</div>
          </div>
          <div className="rounded-md bg-surface-overlay border border-border-subtle px-2.5 py-1.5">
            <div className="text-[10px] text-text-tertiary mb-1">Priority</div>
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-stone-600" style={{ width: `${rec.adminPriority ?? 0}%` }} />
            </div>
            <div className="text-[10px] text-text-primary font-medium mt-0.5 tabular-nums">{rec.adminPriority ?? 0}/100</div>
          </div>
        </div>

        {/* Quick boost panel */}
        {showBoost && (
          <div className="mb-3 rounded-lg border border-border-subtle bg-surface-overlay p-3 space-y-3">
            <BoostSlider label="AI Boost Score" value={boost.aiBoostScore} onChange={(v) => setBoost((b) => ({ ...b, aiBoostScore: v }))} />
            <BoostSlider label="Admin Priority" value={boost.adminPriority} onChange={(v) => setBoost((b) => ({ ...b, adminPriority: v }))} />
            <Button
              size="sm"
              className="w-full"
              disabled={isMutating}
              onClick={() => { onBoost(rec.id, boost); setShowBoost(false); }}
            >
              Apply Boost
            </Button>
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm" variant="secondary"
            className="flex-1"
            onClick={() => onFeature(rec.id, !rec.featured)}
            disabled={isMutating}
          >
            <Star className={`h-3 w-3 ${rec.featured ? "fill-amber-500 text-amber-500" : ""}`} />
            {rec.featured ? "Unfeature" : "Feature"}
          </Button>
          <Button
            size="sm" variant="secondary"
            onClick={() => setShowBoost((s) => !s)}
          >
            <Zap className="h-3 w-3" />
            Boost
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onEdit(rec)}>
            <Settings2 className="h-3 w-3" />
          </Button>
          <Button
            size="sm" variant="secondary"
            className="text-red-500 hover:text-red-600"
            onClick={() => {
              if (window.confirm(`Delete "${rec.name}"?`)) onDelete(rec.id);
            }}
            disabled={isMutating}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RecommendationControlPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState(null);
  const [view, setView]           = useState("control"); // "control" | "analytics"
  const [filterCat, setFilterCat] = useState("all");
  const [filterFeat, setFilterFeat] = useState("all");

  // Queries
  const listQuery = useQuery({
    queryKey: ["rec-control", filterCat, filterFeat],
    queryFn: () => getAdminRecommendationControl({
      ...(filterCat !== "all" ? { category: filterCat } : {}),
      ...(filterFeat === "featured" ? { featured: true } : {}),
    }),
  });

  const analyticsQuery = useQuery({
    queryKey: ["rec-analytics"],
    queryFn: getAdminRecommendationAnalytics,
    enabled: view === "analytics",
  });

  // Mutations
  const createMut = useMutation({
    mutationFn: createAdminRecommendation,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rec-control"] }); setShowForm(false); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateAdminRecommendation(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rec-control"] }); setEditing(null); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteAdminRecommendation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rec-control"] }),
  });

  const boostMut = useMutation({
    mutationFn: ({ id, data }) => boostAdminRecommendation(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rec-control"] }),
  });

  const featureMut = useMutation({
    mutationFn: ({ id, featured }) => featureAdminRecommendation(id, featured),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rec-control"] }),
  });

  const recs = listQuery.data?.data ?? [];
  const analyticsData = analyticsQuery.data?.data ?? [];
  const isMutating = deleteMut.isPending || boostMut.isPending || featureMut.isPending;

  const featuredCount = recs.filter((r) => r.featured).length;
  const trendingCount = recs.filter((r) => r.trending).length;
  const avgBoost = recs.length > 0
    ? Math.round(recs.reduce((s, r) => s + (r.aiBoostScore ?? 0), 0) / recs.length)
    : 0;

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="h-5 w-5 text-text-primary" />
            <h2 className="page-title">AI Recommendation Control Center</h2>
          </div>
          <p className="page-sub">Curate and boost trusted recommendations that guide the AI engine</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === "analytics" ? "default" : "secondary"}
            size="sm"
            onClick={() => setView(view === "analytics" ? "control" : "analytics")}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            {view === "analytics" ? "Back to Control" : "Analytics"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["rec-control"] })}>
            <RefreshCw className={`h-3.5 w-3.5 ${listQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
          {view === "control" && (
            <Button size="sm" onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="h-3.5 w-3.5" />
              Add Place
            </Button>
          )}
        </div>
      </div>

      {/* ── Error alerts ── */}
      {listQuery.isError && <Alert variant="error">{listQuery.error?.message}</Alert>}
      {createMut.isError && <Alert variant="error">{createMut.error?.message}</Alert>}
      {updateMut.isError && <Alert variant="error">{updateMut.error?.message}</Alert>}

      {/* ── Analytics View ── */}
      {view === "analytics" && (
        <div className="space-y-4">
          {analyticsQuery.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Crown}         label="Total Curated"   value={analyticsData.length} />
                <StatCard icon={Heart}         label="Most Liked"      value={analyticsData[0]?.name ?? "—"} sub={analyticsData[0] ? `${analyticsData[0].likes} likes` : ""} />
                <StatCard icon={BookmarkCheck} label="Most Saved"      value={[...analyticsData].sort((a,b)=>b.saves-a.saves)[0]?.name ?? "—"} />
                <StatCard icon={Flame}         label="Top Engagement"  value={analyticsData[0]?.ctr ? `${analyticsData[0].ctr}% CTR` : "—"} />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Engagement Ranking</CardTitle>
                  <span className="text-xs text-text-tertiary">Curated places sorted by engagement score (likes × 3 + saves × 5 + clicks × 2 − dismisses × 2)</span>
                </CardHeader>
                <CardContent>
                  {analyticsData.length === 0 ? (
                    <p className="text-xs text-text-tertiary py-6 text-center">No analytics data yet — add and feature some recommendations first.</p>
                  ) : (
                    <AnalyticsBar data={analyticsData} />
                  )}
                </CardContent>
              </Card>
              {analyticsData.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Category Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={
                        Object.entries(
                          analyticsData.reduce((acc, r) => {
                            acc[r.category] = (acc[r.category] ?? 0) + r.engagementScore;
                            return acc;
                          }, {})
                        ).map(([name, score]) => ({ name, score })).sort((a,b) => b.score - a.score).slice(0, 8)
                      } margin={{ top: 4, right: 4, left: -16, bottom: 30 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eeede9" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#a8a29e" }} angle={-25} textAnchor="end" height={50} />
                        <YAxis tick={{ fontSize: 10, fill: "#a8a29e" }} axisLine={false} tickLine={false} />
                        <Tooltip />
                        <Bar dataKey="score" fill="#57534e" radius={[4,4,0,0]} maxBarSize={40} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Control View ── */}
      {view === "control" && (
        <>
          {/* Stats */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Sparkles}   label="Total Curated"  value={listQuery.isLoading ? "…" : recs.length} />
            <StatCard icon={Star}       label="Featured"       value={listQuery.isLoading ? "…" : featuredCount} iconColor="text-amber-500" />
            <StatCard icon={TrendingUp} label="Trending"       value={listQuery.isLoading ? "…" : trendingCount} iconColor="text-orange-500" />
            <StatCard icon={Zap}        label="Avg AI Boost"   value={listQuery.isLoading ? "…" : `${avgBoost}/100`} />
          </div>

          {/* Personalization notice */}
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
            <div>
              <strong>AI Personalization is always respected.</strong> Admin boosts only influence ranking <em>after</em> all personalization, budget, religion, and interaction filters have been applied. A luxury hotel will never surface for users with a cheap budget, even at 100/100 boost.
            </div>
          </div>

          {/* Create / Edit Form */}
          {showForm && !editing && (
            <RecommendationForm
              onSubmit={(data) => createMut.mutate(data)}
              onCancel={() => setShowForm(false)}
              isPending={createMut.isPending}
            />
          )}
          {editing && (
            <RecommendationForm
              initial={{
                ...EMPTY_FORM,
                ...editing,
                tags: (editing.tags ?? []).join(", "),
                keywords: (editing.keywords ?? []).join(", "),
                galleryUrls: (editing.gallery ?? []).join("\n"),
                address: editing.location?.address ?? "",
                lat: editing.location?.lat ?? "",
                lng: editing.location?.lng ?? "",
                nearbyLandmarks: editing.location?.nearbyLandmarks ?? "",
                areaName: editing.location?.areaName ?? "",
                city: editing.location?.city ?? "",
                region: editing.location?.region ?? "",
                estimatedMealCost: editing.estimatedCost?.meal ?? "",
                estimatedDrinkCost: editing.estimatedCost?.drink ?? "",
                estimatedAvgSpend: editing.estimatedCost?.avgSpend ?? "",
                estimatedTicketCost: editing.estimatedCost?.ticket ?? "",
                estimatedGymCost: editing.estimatedCost?.gym ?? "",
                estimatedEventCost: editing.estimatedCost?.event ?? "",
              }}
              onSubmit={(data) => updateMut.mutate({ id: editing.id, data })}
              onCancel={() => setEditing(null)}
              isPending={updateMut.isPending}
            />
          )}

          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-3.5 w-3.5 text-text-tertiary" />
            <select
              className="text-xs border border-border rounded-md px-2.5 py-1.5 bg-white text-text-secondary"
              value={filterCat}
              onChange={(e) => setFilterCat(e.target.value)}
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              className="text-xs border border-border rounded-md px-2.5 py-1.5 bg-white text-text-secondary"
              value={filterFeat}
              onChange={(e) => setFilterFeat(e.target.value)}
            >
              <option value="all">All places</option>
              <option value="featured">Featured only</option>
            </select>
          </div>

          {/* Grid */}
          {listQuery.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => <SkeletonCard key={i} className="h-56" />)}
            </div>
          ) : recs.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center">
                <Sparkles className="h-10 w-10 text-text-tertiary mx-auto mb-3" />
                <p className="text-sm font-medium text-text-secondary mb-1">No curated recommendations yet</p>
                <p className="text-xs text-text-tertiary mb-4">Add your first place to start guiding the AI recommendation engine.</p>
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Add First Place
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {recs.map((rec) => (
                <RecommendationCard
                  key={rec.id}
                  rec={rec}
                  onEdit={setEditing}
                  onDelete={(id) => deleteMut.mutate(id)}
                  onBoost={(id, data) => boostMut.mutate({ id, data })}
                  onFeature={(id, featured) => featureMut.mutate({ id, featured })}
                  isMutating={isMutating}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
