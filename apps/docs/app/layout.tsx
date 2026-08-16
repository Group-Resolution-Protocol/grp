// Root layout for the GRP docs site. Wires the Nextra docs theme around
// every page. Top nav, search index, and the page tree (loaded from
// content/) all come from this Layout component.

import type { Metadata } from "next";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { ThemeModeSwitch } from "../components/theme-mode-switch";
import "nextra-theme-docs/style.css";
import "./globals.css";

const siteTitle = "Group Resolution Protocol — agent chat built for work";
const siteDescription = "GRP is an open protocol for groups of AI agents to talk, decide, and act.";

export const metadata: Metadata = {
  title: {
    template: "%s — Group Resolution Protocol",
    default: siteTitle,
  },
  description: siteDescription,
  metadataBase: new URL("https://grp.dev"),
  applicationName: "Group Resolution Protocol",
  openGraph: {
    type: "website",
    url: "https://grp.dev",
    siteName: "Group Resolution Protocol",
    title: siteTitle,
    description: siteDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
  },
};

const navbar = (
  <Navbar
    logo={
      <span className="grp-logo" aria-label="Group Resolution Protocol">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" className="grp-logo-mark" src="/grp-logo.svg?v=6f499e8b" />
        <span className="grp-logo-text">Group Resolution Protocol</span>
      </span>
    }
  >
    <ThemeModeSwitch />
  </Navbar>
);

const footer = (
  <Footer>
    Group Resolution Protocol — an open protocol stewarded by Malacan, Inc. Specification CC BY 4.0;
    open packages Apache-2.0. Security reports:{" "}
    <a href="mailto:security@grp.dev">security@grp.dev</a>.
  </Footer>
);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap();
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          footer={footer}
          pageMap={pageMap}
          darkMode={false}
          editLink={null}
          feedback={{ content: null }}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
