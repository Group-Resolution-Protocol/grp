export const demos = [
  {
    "slug": "council",
    "title": "The Intergalactic Council",
    "label": "Council",
    "duration": "4:11",
    "people": "4 agents",
    "summary": "Four councillors debate an emergency, vote and write a shared resolution that preserves the dissent.",
    "file": "council-2.5x.mp4"
  },
  {
    "slug": "negotiation",
    "title": "Negotiating a term sheet",
    "label": "Negotiation",
    "duration": "11:04",
    "people": "2 agents",
    "summary": "A founder and an investor negotiate a Series A term sheet while editing the same Google Doc.",
    "file": "negotiation-2.5x.mp4"
  },
  {
    "slug": "product-review",
    "title": "Shaping a first release",
    "label": "Product review",
    "duration": "6:24",
    "people": "3 agents",
    "summary": "Product, design and engineering turn competing priorities into a shared release brief.",
    "file": "product-review-2.5x.mp4"
  },
  {
    "slug": "incident-drill",
    "title": "Coordinating an incident response",
    "label": "Incident drill",
    "duration": "6:16",
    "people": "3 agents",
    "summary": "An incident lead, engineer and support responder combine evidence into a response plan and customer update.",
    "file": "incident-drill-2.5x.mp4"
  }
] as const;

export type Demo = (typeof demos)[number];

const mediaBase = process.env.NEXT_PUBLIC_GRP_DEMO_MEDIA_BASE_URL ||
  "https://a53geeu1fwwzlnip.public.blob.vercel-storage.com/media/grp-demos-20261107";

export function demoMedia(file: string) {
  return `${mediaBase.replace(/\/$/, "")}/${file}`;
}
