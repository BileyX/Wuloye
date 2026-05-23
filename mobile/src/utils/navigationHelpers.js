/**
 * Safe navigation helpers — avoid "GO_BACK was not handled" when the stack
 * has no previous screen (deep links, push notifications, cold opens).
 */

const DEFAULT_FALLBACK = {
    name: "MainTabs",
    params: { screen: "Home" },
};

/**
 * Pop the stack when possible; otherwise navigate to Home.
 *
 * @param {import('@react-navigation/native').NavigationProp<any>} navigation
 * @param {{ name: string, params?: object }} [fallback]
 */
export function safeGoBack(navigation, fallback = DEFAULT_FALLBACK) {
    if (!navigation) return;

    if (typeof navigation.canGoBack === "function" && navigation.canGoBack()) {
        navigation.goBack();
        return;
    }

    if (fallback?.name) {
        navigation.navigate(fallback.name, fallback.params ?? {});
    }
}
