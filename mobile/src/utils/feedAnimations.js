import { LayoutAnimation, Platform, UIManager } from "react-native";

let layoutEnabled = false;

/** Smooth list shrink when a card is dismissed — avoids jarring instant jumps. */
export function animateFeedRemoval() {
    if (!layoutEnabled) {
        if (
            Platform.OS === "android" &&
            UIManager.setLayoutAnimationEnabledExperimental
        ) {
            UIManager.setLayoutAnimationEnabledExperimental(true);
        }
        layoutEnabled = true;
    }
    LayoutAnimation.configureNext(
        LayoutAnimation.create(
            240,
            LayoutAnimation.Types.easeInEaseOut,
            LayoutAnimation.Properties.opacity,
        ),
    );
}

export function removePlaceFromList(setPlaces, placeId) {
    if (!placeId) return;
    animateFeedRemoval();
    setPlaces((current) =>
        current.filter((item) => (item.placeId ?? item.id) !== placeId),
    );
}
