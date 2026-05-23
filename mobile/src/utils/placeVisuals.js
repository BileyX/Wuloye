/**
 * Shared visual mapping for place / event cards.
 *
 * Both PlaceCard and DiscoverCard need to render a consistent, theme-aware
 * placeholder when a place has no Google photo (events, seed data, etc.).
 * Centralising the mapping here keeps the look identical across surfaces.
 *
 * @param {string} type   place.type string (case-insensitive)
 * @param {boolean} isDark
 * @returns {{ gradient: [string,string], icon: string, accent: string }}
 */
export function getPlaceVisualMeta(type, isDark) {
    const t = String(type ?? "").toLowerCase();

    if (t.includes("gym") || t.includes("fitness") || t.includes("sport") || t.includes("stadium")) {
        return {
            gradient: isDark
                ? ["#0e2d4f", "#0b3d4a"]
                : ["#c8e6ff", "#b8f0de"],
            icon: "barbell",
            accent: isDark ? "#7ee0c7" : "#0a6aa8",
        };
    }
    if (t.includes("cafe") || t.includes("coffee") || t.includes("bakery")) {
        return {
            gradient: isDark
                ? ["#2d1e0e", "#3d2910"]
                : ["#ffe8cc", "#fff3e0"],
            icon: "cafe",
            accent: isDark ? "#f0b27a" : "#b06420",
        };
    }
    if (t.includes("restaurant") || t.includes("food") || t.includes("dining")) {
        return {
            gradient: isDark
                ? ["#2d180e", "#3a1d12"]
                : ["#ffe0d6", "#ffece4"],
            icon: "restaurant",
            accent: isDark ? "#ff9d80" : "#c25a4a",
        };
    }
    if (t.includes("hotel") || t.includes("lodging") || t.includes("hostel")) {
        return {
            gradient: isDark
                ? ["#1a1528", "#221a38"]
                : ["#ede7ff", "#f5f0ff"],
            icon: "bed",
            accent: isDark ? "#b39dff" : "#5d3fd3",
        };
    }
    if (t.includes("park") || t.includes("trail") || t.includes("walk") || t.includes("outdoor")) {
        return {
            gradient: isDark
                ? ["#0e2d1a", "#0d3d24"]
                : ["#d4f5e0", "#e0f8e8"],
            icon: "leaf",
            accent: isDark ? "#76dba0" : "#2f8a52",
        };
    }
    if (t.includes("church") || t.includes("worship") || t.includes("religious")) {
        return {
            gradient: isDark
                ? ["#1a1a2e", "#16213e"]
                : ["#e8e0ff", "#f0eaff"],
            icon: "business",
            accent: isDark ? "#a397ff" : "#5d50c0",
        };
    }
    if (t.includes("event") || t.includes("music") || t.includes("concert")) {
        return {
            gradient: isDark
                ? ["#1a0e2d", "#2d1040"]
                : ["#ffe0f0", "#fce8ff"],
            icon: "musical-notes",
            accent: isDark ? "#ff8fd0" : "#c2348f",
        };
    }
    if (t.includes("workspace") || t.includes("office") || t.includes("study") || t.includes("co-work")) {
        return {
            gradient: isDark
                ? ["#0d1f0e", "#0e2d14"]
                : ["#e0f5e8", "#d4f7e0"],
            icon: "briefcase",
            accent: isDark ? "#7adf91" : "#2f8a52",
        };
    }
    if (t.includes("yoga") || t.includes("wellness") || t.includes("spa")) {
        return {
            gradient: isDark
                ? ["#1d0e2d", "#28133a"]
                : ["#f5e0ff", "#ffe8f5"],
            icon: "flower",
            accent: isDark ? "#d39bff" : "#8a3fd3",
        };
    }
    if (t.includes("social") || t.includes("bar") || t.includes("nightlife")) {
        return {
            gradient: isDark
                ? ["#221620", "#2d1a30"]
                : ["#ffe0f5", "#f8e0ff"],
            icon: "wine",
            accent: isDark ? "#ffb0e0" : "#a83b80",
        };
    }
    return {
        gradient: isDark
            ? ["#0e1f2d", "#0b2a3a"]
            : ["#daf0ff", "#e0f8f2"],
        icon: "location",
        accent: isDark ? "#8dd0ff" : "#0a6aa8",
    };
}
