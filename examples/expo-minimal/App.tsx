import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Button, FlatList, SafeAreaView, Text } from "react-native";
import { createShop, type Shop } from "./src/shop";

const config = {
  url: process.env.EXPO_PUBLIC_POCKETBOMB_URL || "http://127.0.0.1:8090",
  publicKey: process.env.EXPO_PUBLIC_POCKETBOMB_PUBLIC_KEY || "",
  clientId: process.env.EXPO_PUBLIC_POCKETBOMB_CLIENT_ID || "example_shop",
  // the app scheme (app.json) registered as the OAuth2 client redirect URI
  redirectUri: "pocketbombshop://auth/callback",
};

export default function App() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [products, setProducts] = useState<Array<{ id: string; title: string }>>([]);
  const [email, setEmail] = useState("");

  useEffect(() => {
    createShop({
      ...config,
      storage: AsyncStorage,
      openAuthSession: (url, redirectUri) => WebBrowser.openAuthSessionAsync(url, redirectUri),
    })
      .then(async (created) => {
        setShop(created);
        setEmail(created.authStore.record?.email || "");
        setProducts(await created.products());
      })
      .catch((err) => console.warn("PocketBomb setup failed", err));
  }, []);

  const login = async () => {
    const result = await shop?.customer.login();
    setEmail(result?.record?.email || "");
  };

  const logout = async () => {
    await shop?.customer.logout();
    setEmail("");
  };

  return (
    <SafeAreaView>
      <Text>{email ? "Signed in as " + email : "Not signed in"}</Text>
      {email ? (
        <Button title="Sign out" onPress={logout} />
      ) : (
        <Button title="Sign in" onPress={login} />
      )}
      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => <Text>{item.title}</Text>}
      />
    </SafeAreaView>
  );
}
