import { Capacitor } from "@capacitor/core";
import * as api from "./api";

/**
 * Native-only setup. All of this is a no-op when running as a plain website.
 */
export async function initNative() {
  if (!Capacitor.isNativePlatform()) return;

  const [{ StatusBar, Style }, { SplashScreen }, { PushNotifications }] = await Promise.all([
    import("@capacitor/status-bar"),
    import("@capacitor/splash-screen"),
    import("@capacitor/push-notifications"),
  ]);

  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: "#0d1117" });
  await SplashScreen.hide();

  // Request push notification permission and register token with Supabase
  const { receive: permResult } = await PushNotifications.requestPermissions();
  if (permResult === "granted") {
    await PushNotifications.register();

    PushNotifications.addListener("registration", async ({ value: token }) => {
      try {
        await api.registerPushToken(token, "android");
      } catch (e) {
        console.error("Push token registration failed:", e);
      }
    });

    PushNotifications.addListener("registrationError", (err) => {
      console.error("Push registration error:", err);
    });
  }
}

