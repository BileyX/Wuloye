import * as WebBrowser from "expo-web-browser";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { ThemeProvider, useAppTheme } from "./src/context/ThemeContext";
import { NotificationProvider } from "./src/context/NotificationContext";
import { InteractionStateProvider } from "./src/context/InteractionStateContext";
import { SavedPlacesProvider } from "./src/context/SavedPlacesContext";
import AppNavigator from "./src/navigation/AppNavigator";
import { THEMES } from "./src/theme/theme";

WebBrowser.maybeCompleteAuthSession();

const linking = {
    prefixes: ["wuloye://"],
    config: {
        screens: {
            MainTabs: {
                screens: {
                    Home: "home",
                    Discover: {
                        path: "discover",
                    },
                    YourSchedule: "schedule",
                    Events: "events",
                    Profile: "profile",
                },
            },
            PlaceDetail: {
                path: "place/:placeId",
            },
            EventDetail: {
                path: "event/:eventId",
            },
            ActivityRecommendations: {
                path: "recommendations",
            },
            SavedPlaces: "saved",
            Trending: "trending",
            Chat: "chat",
            NotificationSettings: "notification-settings",
            Reminders: "reminders",
            ReminderEditor: "reminder-editor",
        },
    },
};

function InnerApp() {
    const { profile } = useAuth();

    return (
        <InteractionStateProvider>
            <SavedPlacesProvider>
                <NotificationProvider profile={profile}>
                    <AppNavigator />
                </NotificationProvider>
            </SavedPlacesProvider>
        </InteractionStateProvider>
    );
}

function AppContent() {
    const { navigationTheme, mode } = useAppTheme();

    const mergedTheme = {
        ...DefaultTheme,
        ...navigationTheme,
        colors: {
            ...DefaultTheme.colors,
            ...navigationTheme.colors,
        },
    };

    return (
        <NavigationContainer theme={mergedTheme} linking={linking}>
            <StatusBar style={mode === THEMES.DARK ? "light" : "dark"} />
            <InnerApp />
        </NavigationContainer>
    );
}

export default function App() {
    return (
        <ThemeProvider>
            <AuthProvider>
                <AppContent />
            </AuthProvider>
        </ThemeProvider>
    );
}
