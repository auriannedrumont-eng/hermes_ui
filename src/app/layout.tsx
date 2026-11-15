import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";
import { SingleTabGuard } from "@/components/single-tab-guard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hermes Web — Chat pour l'agent Hermes",
  description:
    "Interface de chat type ChatGPT pour l'agent Hermes de Nous Research : conversations persistantes, streaming, outils, raisonnement et pièces jointes multimédia.",
  manifest: "/manifest.webmanifest",
  applicationName: "Hermes Web",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Hermes Web",
  },
  keywords: [
    "Hermes",
    "Nous Research",
    "agent",
    "chat",
    "interface web",
    "LLM",
  ],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#da5e25",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <PwaRegister />
          <SingleTabGuard />
        </ThemeProvider>
      </body>
    </html>
  );
}
