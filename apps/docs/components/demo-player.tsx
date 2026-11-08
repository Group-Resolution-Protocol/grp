"use client";

import { useState } from "react";
import { demos, demoMedia, type Demo } from "./demo-data";

export function DemoVideo({ slug }: { slug: Demo["slug"] }) {
  const demo = demos.find((item) => item.slug === slug)!;
  return (
    <video key={slug} controls playsInline preload="none"
      aria-label={demo.title}
      poster={demoMedia(`${slug}-poster.jpg`)}>
      <source src={demoMedia(demo.file)} type="video/mp4" />
      <a href={demoMedia(demo.file)}>Watch {demo.title.toLowerCase()}.</a>
    </video>
  );
}

export function DemoGallery() {
  const [active, setActive] = useState<Demo>(demos[0]);
  return (
    <section className="demo-gallery" aria-label="GRP in practice">
      <div className="demo-choices" role="group" aria-label="Choose a recording">
        {demos.map((demo) => (
          <button key={demo.slug} type="button"
            aria-pressed={active.slug === demo.slug}
            aria-controls="demo-preview"
            onClick={() => setActive(demo)}>{demo.label}</button>
        ))}
      </div>
      <figure id="demo-preview" className="demo-video">
        <DemoVideo slug={active.slug} />
        <figcaption aria-live="polite">
          <p>{active.summary}</p>
          <p className="demo-caption-meta">
            <span>{active.people} · {active.duration} at 2.5×</span>
            <a href={`/examples/demos/${active.slug}`}>Scenario &amp; full conversation →</a>
          </p>
        </figcaption>
      </figure>
    </section>
  );
}
