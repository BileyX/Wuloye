$ErrorActionPreference = "Continue"
Set-Location "c:\Users\biruk\Desktop\wuloye\Wuloye-"
$wip = "wip/team-batch-all"
$base = "main"

function New-TeamCommit {
    param([string]$Name, [string]$Email, [string]$Msg)
    $tree = git write-tree
    $parent = git rev-parse $base
    $bat = @"
@echo off
set GIT_AUTHOR_NAME=$Name
set GIT_AUTHOR_EMAIL=$Email
set GIT_COMMITTER_NAME=$Name
set GIT_COMMITTER_EMAIL=$Email
for /f %%i in ('git commit-tree $tree -p $parent -m "$Msg"') do set NEW=%%i
git reset --hard %NEW%
"@
    $batPath = Join-Path $env:TEMP "wuloye-commit-tree.bat"
    [System.IO.File]::WriteAllText($batPath, $bat)
    & "C:\Windows\System32\cmd.exe" /c $batPath | Out-Null
}

function Publish-Branch {
    param(
        [string]$Branch,
        [string]$Name,
        [string]$Email,
        [string]$Msg,
        [string[]]$Paths
    )
    git checkout $base | Out-Null
    git branch -D $Branch 2>&1 | Out-Null
    git checkout -b $Branch 2>&1 | Out-Null
    git checkout $wip -- @Paths 2>$null
    git add -A
    New-TeamCommit -Name $Name -Email $Email -Msg $Msg
    git push -u origin $Branch --force-with-lease
    Write-Host "OK $Branch -> $Name"
}

Publish-Branch "feature/BileyX/backend-services-personalization-batch" "BileyX" "brxsitota@gmail.com" "feat(backend): events, AI schedule, personalization, pricing, and user services" @(
    "backend/.env.example",
    "backend/data/model.json",
    "backend/src/app.js",
    "backend/src/controllers/event.controller.js",
    "backend/src/controllers/user.controller.js",
    "backend/src/routes/admin.routes.js",
    "backend/src/routes/user.routes.js",
    "backend/src/services/aiFeedback.service.js",
    "backend/src/services/aiSchedule.service.js",
    "backend/src/services/event.service.js",
    "backend/src/services/interaction.service.js",
    "backend/src/services/place.service.js",
    "backend/src/services/recommendation.service.js",
    "backend/src/services/user.service.js",
    "backend/src/utils/personalization.js",
    "backend/src/utils/pricing.utils.js"
)

git checkout $base | Out-Null
git branch -D "feature/biruk-1/admin-dashboard-and-mobile-integration" 2>$null | Out-Null
git checkout -b "feature/biruk-1/admin-dashboard-and-mobile-integration" | Out-Null
git checkout $wip -- admin-dashboard
git checkout $wip -- mobile/src/navigation/AppNavigator.js mobile/src/screens/PlaceDetailScreen.js mobile/src/api/placeApi.js mobile/src/components/PlaceInteractionBar.js mobile/src/hooks/usePlaceInteractions.js
git add -A
New-TeamCommit -Name "biruk-1" -Email "99360145+biruk-1@users.noreply.github.com" -Msg "feat(admin, mobile): dashboard analytics, moderation, places, and place detail integration"
git push -u origin feature/biruk-1/admin-dashboard-and-mobile-integration --force-with-lease
Write-Host "OK feature/biruk-1/admin-dashboard-and-mobile-integration -> biruk-1"

Publish-Branch "feature/biruk-1/ai-learning-feedback-batch" "biruk-1" "99360145+biruk-1@users.noreply.github.com" "feat(ai-service): bandit learning, feedback, events router, and pipeline updates" @(
    "ai-service/data/bandit_state.json",
    "ai-service/data/model_meta.json",
    "ai-service/learning",
    "ai-service/models/bandit.py",
    "ai-service/pipeline/data_pipeline.py",
    "ai-service/routers/events.py",
    "ai-service/routers/feedback.py",
    "ai-service/routers/predict.py"
)

Publish-Branch "feature/BrookGT/mobile-discover-events-ui" "BrookGT" "133872895+BrookGT@users.noreply.github.com" "feat(mobile): discover, trending, events screens, and recommendation cards" @(
    "mobile/src/components/DiscoverCard.js",
    "mobile/src/components/PlaceCard.js",
    "mobile/src/screens/DiscoverScreen.js",
    "mobile/src/screens/TrendingScreen.js",
    "mobile/src/screens/ActivityRecommendationsScreen.js",
    "mobile/src/screens/EventsScreen.js",
    "mobile/src/screens/EventDetailScreen.js",
    "mobile/src/api/eventsApi.js",
    "mobile/src/utils/recommendationPlaces.js",
    "mobile/src/utils/constants.js"
)

Publish-Branch "feature/Biruk-bejiga/mobile-auth-profile-routines" "Biruk-bejiga" "birukbejga8@gmail.com" "feat(mobile): login, profile, home, routines, and saved places" @(
    "mobile/src/screens/LoginScreen.js",
    "mobile/src/screens/ProfileScreen.js",
    "mobile/src/screens/ProfileSetupScreen.js",
    "mobile/src/screens/SavedPlacesScreen.js",
    "mobile/src/screens/HomeScreen.js",
    "mobile/src/screens/RoutineScreen.js",
    "mobile/src/screens/RoutineBuilderScreen.js",
    "mobile/src/context/AuthContext.js",
    "mobile/src/api/profileApi.js"
)

git checkout $base | Out-Null
Write-Host "Done. All branches pushed."
