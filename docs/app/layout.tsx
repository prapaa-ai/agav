import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { SITE_NAME, SITE_URL } from "@/lib/site";

const googleSansCode = localFont({
  src: [
    {
      path: "../public/fonts/google-sans-code-latin.woff2",
      weight: "300 800",
      style: "normal",
    },
    {
      path: "../public/fonts/google-sans-code-symbols.woff2",
      weight: "300 800",
      style: "normal",
    },
    {
      path: "../public/fonts/google-sans-code-symbols2.woff2",
      weight: "300 800",
      style: "normal",
    },
  ],
  variable: "--font-google-sans-code",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: "%s | Agav Docs",
  },
  description: "Documentation for Agav, the terminal-native AI coding assistant.",
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-icon.png",
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: SITE_NAME,
    description: "Documentation for Agav, the terminal-native AI coding assistant.",
    url: SITE_URL,
    siteName: SITE_NAME,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: "Documentation for Agav, the terminal-native AI coding assistant.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${googleSansCode.variable} antialiased`}
      suppressHydrationWarning
    >
      <body
        className="min-h-screen bg-background text-foreground antialiased"
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
