import { Navigate, Route, Routes } from "react-router-dom";
import DashboardLayout from "@/components/layout/DashboardLayout";
import AdminGate from "@/components/auth/AdminGate";
import DashboardPage from "@/features/dashboard/DashboardPage";
import UsersPage from "@/features/users/UsersPage";
import InteractionsPage from "@/features/interactions/InteractionsPage";
import RecommendationsPage from "@/features/recommendations/RecommendationsPage";
import ExperimentsPage from "@/features/experiments/ExperimentsPage";
import AiModelPage from "@/features/aiModel/AiModelPage";
import RoutinesPage from "@/features/routines/RoutinesPage";
import DevToolsPage from "@/features/devTools/DevToolsPage";
import EventsPage from "@/features/events/EventsPage";
import SystemPage from "@/features/system/SystemPage";
import PlacesAdminPage from "@/features/places/PlacesAdminPage";
import AnalyticsHubPage from "@/features/analytics/AnalyticsHubPage";
import ModerationPage from "@/features/moderation/ModerationPage";
import NotificationsAdminPage from "@/features/notifications/NotificationsAdminPage";
import RecommendationControlPage from "@/features/recommendationControl/RecommendationControlPage";
import TrendingManagementPage from "@/features/trending/TrendingManagementPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AdminGate />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/places" element={<PlacesAdminPage />} />
          <Route path="/interactions" element={<InteractionsPage />} />
          <Route path="/recommendations" element={<RecommendationsPage />} />
          <Route path="/ai-model" element={<AiModelPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/analytics" element={<AnalyticsHubPage />} />
          <Route path="/moderation" element={<ModerationPage />} />
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/notifications" element={<NotificationsAdminPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/dev-tools" element={<DevToolsPage />} />
          <Route path="/recommendation-control" element={<RecommendationControlPage />} />
          <Route path="/trending-management" element={<TrendingManagementPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
