#!/usr/bin/env bash
# Rebuilds MIHIR-Tasks.apk from src/ + AndroidManifest.xml + res/ WITHOUT the Android SDK / an API 34 android.jar,
# using apktool (its framework knows the new manifest attributes) and Ubuntu's Android 6 android.jar for compiling.
# Android 8+ APIs are called by reflection in the Java code, so it compiles against Android 6.
#   sudo apt install apktool aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 openjdk-17-jdk-headless
#   ./android/rebuild-apk-apktool.sh        (bump android:versionCode / versionName in AndroidManifest.xml first)
set -euo pipefail
cd "$(dirname "$0")"
J=/usr/lib/android-sdk/platforms/android-23/android.jar
KS_PASS="${KS_PASS:-mihirtasks2026}"
SITE_URL="${SITE_URL:-https://mihir-task-manager.onrender.com}"
VC=$(grep -o 'android:versionCode="[0-9]*"' AndroidManifest.xml | grep -o '[0-9]*'); VN=$(grep -o 'android:versionName="[^"]*"' AndroidManifest.xml | cut -d'"' -f2)
B=$(mktemp -d)
apktool d -s -f MIHIR-Tasks.apk -o "$B/dec" >/dev/null
rm -rf "$B/dec/res"; cp -r res "$B/dec/res"; sed -i "s#__SITE_URL__#${SITE_URL}#" "$B/dec/res/values/strings.xml"
cp AndroidManifest.xml "$B/dec/AndroidManifest.xml"
sed -i "s/versionCode: '[0-9]*'/versionCode: '${VC}'/; s/versionName: '[^']*'/versionName: '${VN}'/" "$B/dec/apktool.yml"
mkdir -p "$B/mf" "$B/gen" "$B/classes"
sed 's/android:foregroundServiceType="[^"]*"//' AndroidManifest.xml > "$B/mf/AndroidManifest.xml"
aapt package -f -m -J "$B/gen" -M "$B/mf/AndroidManifest.xml" -S "$B/dec/res" -I "$J"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$J" -Xlint:-options -d "$B/classes" "$B/gen/com/mihir/taskmanager/R.java" src/com/mihir/taskmanager/*.java
dalvik-exchange --dex --min-sdk-version=23 --output="$B/dec/classes.dex" "$B/classes"
apktool b "$B/dec" -o "$B/unsigned.apk" >/dev/null
zipalign -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"
apksigner sign --ks mihir-tasks.keystore --ks-key-alias mihir --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out MIHIR-Tasks.apk "$B/aligned.apk"
rm -f MIHIR-Tasks.apk.idsig
apksigner verify MIHIR-Tasks.apk && aapt dump badging MIHIR-Tasks.apk | head -1
