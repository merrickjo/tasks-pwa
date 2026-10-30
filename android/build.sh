#!/usr/bin/env bash
# Builds the Notch APK with the Android SDK tools only — no Gradle, no
# downloaded libraries. Needs: ANDROID_HOME (platform 35 + build-tools 35),
# a JDK, and the signing key (keystore + password file; never in git).
#   ANDROID_HOME=… KEYSTORE=…/notch.jks KEYPASS_FILE=…/notch.pass ./build.sh 2 "1.1"
set -euo pipefail
cd "$(dirname "$0")"
VCODE="${1:-1}"; VNAME="${2:-1.0}"
BT="$ANDROID_HOME/build-tools/35.0.0"; JAR="$ANDROID_HOME/platforms/android-35/android.jar"
rm -rf build && mkdir -p build/res build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res/
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VCODE" --version-name "$VNAME" \
  --java build/gen build/res/*.flat
javac -source 11 -target 11 -nowarn -classpath "$JAR" -d build/classes \
  $(find src build/gen -name '*.java') 2>&1 | grep -v "bootstrap class path" || true
"$BT/d8" --min-api 26 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
cp build/unsigned.apk build/with-dex.apk
(cd build/dex && zip -q -j ../with-dex.apk classes.dex)
export NOTCH_KP="$(cat "$KEYPASS_FILE")"
"$BT/zipalign" -f -p 4 build/with-dex.apk build/aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass env:NOTCH_KP --key-pass env:NOTCH_KP \
  --out "build/notch-$VNAME.apk" build/aligned.apk
"$BT/apksigner" verify --print-certs "build/notch-$VNAME.apk" | head -3
echo "built android/build/notch-$VNAME.apk"
