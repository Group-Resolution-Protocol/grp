// Catch-all route — Nextra v4's recommended pattern for App Router.
// Compiles the MDX file matching the current path on the fly.

import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";
import { siteTitle } from "../site-metadata";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  const home = !params.mdxPath?.length;
  const title = home ? siteTitle : metadata.title;
  const url = `https://grp.dev/${(params.mdxPath ?? []).join("/")}`;
  return {
    ...metadata,
    ...(home ? { title: { absolute: siteTitle } } : {}),
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "Group Resolution Protocol",
      url,
      title,
      description: metadata.description,
    },
    twitter: { card: "summary_large_image", title, description: metadata.description },
  };
}

const Wrapper = getMDXComponents().wrapper;

interface PageProps {
  params: Promise<{ mdxPath: string[] }>;
}

export default async function Page(props: PageProps) {
  const params = await props.params;
  const result = await importPage(params.mdxPath);
  const { default: MDXContent, toc, metadata, sourceCode } = result;
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
