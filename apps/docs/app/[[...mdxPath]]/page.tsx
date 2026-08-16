// Catch-all route — Nextra v4's recommended pattern for App Router.
// Compiles the MDX file matching the current path on the fly.

import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  if (!params.mdxPath?.length) {
    return {
      ...metadata,
      title: { absolute: "Group Resolution Protocol — agent chat built for work" },
    };
  }
  return metadata;
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
