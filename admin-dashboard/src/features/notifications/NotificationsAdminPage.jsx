import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Send, Smartphone, Users } from "lucide-react";
import {
  postAdminAnnouncement,
  getAdminNotifications,
  getAdminNotificationStats,
} from "@/services/endpoints";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingState } from "@/components/ui/loading";

const SEVERITIES = [
  { value: "info", label: "Informational" },
  { value: "warning", label: "Heads-up" },
  { value: "maint", label: "Maintenance" },
  { value: "promo", label: "Promotional" },
];

const DEEP_LINK_PRESETS = [
  { value: "wuloye://home", label: "Home" },
  { value: "wuloye://trending", label: "Trending" },
  { value: "wuloye://events", label: "Events" },
  { value: "wuloye://discover", label: "Discover" },
  { value: "wuloye://schedule", label: "Planner" },
];

function formatDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

export default function NotificationsAdminPage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [severity, setSeverity] = useState("info");
  const [deepLink, setDeepLink] = useState("wuloye://home");
  const [lastResult, setLastResult] = useState(null);

  const statsQuery = useQuery({
    queryKey: ["admin-notification-stats"],
    queryFn: getAdminNotificationStats,
    refetchInterval: 30_000,
  });

  const historyQuery = useQuery({
    queryKey: ["admin-notifications"],
    queryFn: getAdminNotifications,
  });

  const mut = useMutation({
    mutationFn: () =>
      postAdminAnnouncement({
        title: title.trim(),
        body: body.trim(),
        subtitle: subtitle.trim(),
        severity,
        deepLink,
      }),
    onSuccess: (res) => {
      setLastResult(res?.data ?? null);
      setTitle("");
      setBody("");
      setSubtitle("");
      queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
    },
  });

  const handleSubmit = () => mut.mutate();
  const isDisabled = mut.isPending || !title.trim() || !body.trim();

  const stats = statsQuery.data?.data ?? { devices: 0, users: 0 };
  const history = historyQuery.data?.data ?? [];

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h2 className="page-title">Notifications</h2>
          <p className="page-sub">
            Send push announcements to all registered mobile devices via Expo
          </p>
        </div>
      </div>

      {/* Device stats */}
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Card>
          <CardContent className="flex items-center gap-3 pt-5">
            <Smartphone className="h-5 w-5 text-text-tertiary" />
            <div>
              <p className="text-2xl font-semibold text-text-primary">
                {statsQuery.isLoading ? "…" : stats.devices}
              </p>
              <p className="text-xs text-text-secondary">Registered devices</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-5">
            <Users className="h-5 w-5 text-text-tertiary" />
            <div>
              <p className="text-2xl font-semibold text-text-primary">
                {statsQuery.isLoading ? "…" : stats.users}
              </p>
              <p className="text-xs text-text-secondary">Users with push enabled</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Compose */}
        <Card>
          <CardHeader>
            <CardTitle>New Announcement</CardTitle>
            <span className="text-xs text-text-tertiary">
              Delivered via Expo Push · opens deep link on tap
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="label-xs">Type</label>
              <div className="flex flex-wrap gap-2">
                {SEVERITIES.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSeverity(value)}
                    className={
                      severity === value
                        ? "rounded-full bg-text-primary text-white px-3 py-1 text-xs font-medium border border-text-primary"
                        : "rounded-full bg-white text-text-secondary border border-border px-3 py-1 text-xs font-medium hover:border-border-strong hover:text-text-primary transition-colors"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="label-xs">Title</label>
              <input
                className="input-base"
                placeholder="e.g. Scheduled maintenance this weekend"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="label-xs">Subtitle (optional)</label>
              <input
                className="input-base"
                placeholder="Short context line"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="label-xs">Message body</label>
              <textarea
                className="input-base"
                rows={4}
                style={{ height: "auto", resize: "vertical" }}
                placeholder="Write your announcement here…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="label-xs">Deep link on tap</label>
              <select
                className="input-base"
                value={deepLink}
                onChange={(e) => setDeepLink(e.target.value)}
              >
                {DEEP_LINK_PRESETS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label} ({value})
                  </option>
                ))}
              </select>
            </div>

            {mut.isError && <Alert variant="error">{mut.error?.message}</Alert>}

            {lastResult?.id && (
              <Alert variant="success">
                Push sent — {lastResult.pushStats?.sent ?? 0} delivered,{" "}
                {lastResult.pushStats?.failed ?? 0} failed across{" "}
                {lastResult.pushStats?.targetedDevices ?? 0} devices.
              </Alert>
            )}

            {stats.devices === 0 && !statsQuery.isLoading && (
              <Alert variant="warning">
                No devices registered yet. Users must open the mobile app and
                grant notification permission.
              </Alert>
            )}

            <div className="flex justify-end pt-1">
              <Button disabled={isDisabled} onClick={handleSubmit}>
                <Send className="h-3.5 w-3.5" />
                {mut.isPending ? "Sending…" : "Send push notification"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader>
            <CardTitle>Recent broadcasts</CardTitle>
          </CardHeader>
          <CardContent>
            {historyQuery.isLoading ? (
              <LoadingState label="Loading history…" />
            ) : history.length === 0 ? (
              <p className="text-sm text-text-secondary">No announcements sent yet.</p>
            ) : (
              <ul className="space-y-3 max-h-[480px] overflow-y-auto">
                {history.map((n) => (
                  <li
                    key={n.id}
                    className="rounded-lg border border-border-subtle bg-surface-overlay px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-text-primary">{n.title}</p>
                      <span className="text-[10px] uppercase tracking-wide text-text-tertiary shrink-0">
                        {n.type}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary mt-1 line-clamp-2">{n.message}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px] text-text-tertiary">
                      <span>{formatDate(n.sentAt)}</span>
                      {n.pushStats && (
                        <span>
                          {n.pushStats.sent} sent · {n.pushStats.targetedDevices} devices
                        </span>
                      )}
                      {n.deepLink && <span>{n.deepLink}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-overlay px-4 py-3 max-w-3xl">
        <Bell className="h-4 w-4 text-text-tertiary mt-0.5 shrink-0" />
        <p className="text-xs text-text-secondary">
          Push notifications are delivered through Expo Push Notification service.
          Each device registers its token when the user grants permission and is
          signed in. Invalid tokens are automatically deactivated after failed delivery.
        </p>
      </div>
    </div>
  );
}
