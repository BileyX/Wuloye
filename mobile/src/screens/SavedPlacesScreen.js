import { memo, useCallback, useMemo, useRef } from "react";

import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";

import { LinearGradient } from "expo-linear-gradient";

import { Ionicons } from "@expo/vector-icons";

import { useFocusEffect } from "@react-navigation/native";

import PlaceCard from "../components/PlaceCard";

import EmptyState from "../components/EmptyState";

import PlaceListSkeleton from "../components/PlaceListSkeleton";

import TopGreetingBanner from "../components/TopGreetingBanner";

import { useSavedPlaces } from "../hooks/useSavedPlaces";

import { useAppTheme } from "../context/ThemeContext";

import { prefetchPlaceDetails } from "../api/placeApi";



const ESTIMATED_CARD_HEIGHT = 380;



const SavedPlaceRow = memo(function SavedPlaceRow({ item, onOpen, onDismiss }) {

    const placeId = item.placeId ?? item.id;



    const handlePress = useCallback(() => {

        onOpen(item);

    }, [item, onOpen]);



    const handlePressIn = useCallback(() => {

        prefetchPlaceDetails(placeId);

    }, [placeId]);



    const handleDismiss = useCallback(() => {

        onDismiss(item);

    }, [item, onDismiss]);



    return (

        <PlaceCard

            place={item}

            onPress={handlePress}

            onPressIn={handlePressIn}

            onDismiss={handleDismiss}

            animateEntrance={false}

        />

    );

});



export default function SavedPlacesScreen({ navigation }) {

    const { palette, gradients } = useAppTheme();

    const styles = useMemo(() => createStyles(palette), [palette]);



    const {

        loading,

        error,

        saved,

        refreshing,

        loadSaved,

        handleRefresh,

        handleDismiss,

    } = useSavedPlaces();



    const loadedOnce = useRef(false);



    useFocusEffect(

        useCallback(() => {

            loadSaved({ silent: loadedOnce.current });

            loadedOnce.current = true;

        }, [loadSaved]),

    );



    const openPlaceDetail = useCallback(

        (place) => {

            prefetchPlaceDetails(place?.placeId ?? place?.id);

            const parent =

                typeof navigation.getParent === "function"

                    ? navigation.getParent()

                    : null;

            if (parent?.navigate) {

                parent.navigate("PlaceDetail", { place });

                return;

            }

            navigation.navigate("PlaceDetail", { place });

        },

        [navigation],

    );



    const onDismiss = useCallback(

        (place) => {

            handleDismiss(place, { source: "saved_places_screen" });

        },

        [handleDismiss],

    );



    const browseHome = useCallback(() => {

        navigation.navigate("MainTabs", { screen: "Home" });

    }, [navigation]);



    const renderItem = useCallback(

        ({ item }) => (

            <SavedPlaceRow

                item={item}

                onOpen={openPlaceDetail}

                onDismiss={onDismiss}

            />

        ),

        [openPlaceDetail, onDismiss],

    );



    const keyExtractor = useCallback(

        (item) => String(item.placeId ?? item.id),

        [],

    );



    const canGoBack = navigation.canGoBack();

    const showEmpty = !loading && saved.length === 0;



    return (

        <SafeAreaView style={styles.safeArea}>

            <LinearGradient

                colors={gradients.appBackground}

                style={styles.screen}

            >

                {canGoBack ? (

                    <Pressable

                        style={styles.backRow}

                        onPress={() => navigation.goBack()}

                        hitSlop={12}

                        accessibilityRole="button"

                        accessibilityLabel="Go back"

                    >

                        <Ionicons

                            name="chevron-back"

                            size={22}

                            color={palette.textPrimary}

                        />

                        <Text style={styles.backLabel}>Back</Text>

                    </Pressable>

                ) : null}



                <TopGreetingBanner

                    eyebrow="Your collection"

                    title="Saved Places"

                    subtitle="All your favorites in one place, ready whenever you are"

                    onAction={handleRefresh}

                    actionIcon="refresh-outline"

                />



                {error ? <Text style={styles.errorText}>{error}</Text> : null}



                {loading ? (

                    <View style={styles.list}>

                        <PlaceListSkeleton variant="home" count={3} />

                    </View>

                ) : showEmpty ? (

                    <EmptyState

                        message="No saved places yet. Start saving your favorites."

                        ctaLabel="Browse Home"

                        onPress={browseHome}

                    />

                ) : (

                    <FlatList

                        data={saved}

                        keyExtractor={keyExtractor}

                        renderItem={renderItem}

                        refreshing={refreshing}

                        onRefresh={handleRefresh}

                        contentContainerStyle={styles.list}

                        initialNumToRender={4}

                        maxToRenderPerBatch={5}

                        windowSize={7}

                        removeClippedSubviews

                        getItemLayout={(_, index) => ({

                            length: ESTIMATED_CARD_HEIGHT,

                            offset: ESTIMATED_CARD_HEIGHT * index,

                            index,

                        })}

                    />

                )}

            </LinearGradient>

        </SafeAreaView>

    );

}



function createStyles(palette) {

    return StyleSheet.create({

        safeArea: { flex: 1, backgroundColor: palette.pageTop },

        screen: { flex: 1, paddingHorizontal: 16 },

        backRow: {

            flexDirection: "row",

            alignItems: "center",

            gap: 2,

            marginTop: 4,

            marginBottom: 6,

            alignSelf: "flex-start",

            paddingVertical: 4,

            paddingRight: 12,

        },

        backLabel: {

            color: palette.textPrimary,

            fontSize: 16,

            fontWeight: "700",

        },

        errorText: {

            color: palette.danger,

            marginTop: 8,

        },

        list: {

            marginTop: 14,

            paddingBottom: 24,

        },

    });

}


