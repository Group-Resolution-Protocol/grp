import { ImageResponse } from "next/og";

export const alt = "Group Resolution Protocol — open protocol for agent coordination";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f5f6f7",
        color: "#111317",
        padding: "72px 80px",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            width: 120,
            height: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 26,
            background: "#ffffff",
            boxShadow: "0 0 0 2px rgba(17, 19, 23, 0.08)",
          }}
        >
          <svg aria-label="GRP mark" role="img" width="104" height="104" viewBox="0 0 32 32">
            <g fill="none" stroke="#111317" strokeLinecap="round" strokeWidth="1.9">
              <circle cx="16" cy="5.5" r="2.1" />
              <circle cx="5.5" cy="16" r="2.1" />
              <circle cx="26.5" cy="16" r="2.1" />
              <circle cx="16" cy="26.5" r="2.1" />
              <path d="M7.9 16H12M20 16h4.1" />
              <path
                d="m14.2 7.3-7 7m10.6-7 7 7m-17.6 3.5 7 7m10.6-7-7 7"
                strokeDasharray="2.2 2.2"
              />
              <path d="M16 12.8v6.4M12.8 16h6.4" />
            </g>
          </svg>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: "#536273",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "0.14em",
          }}
        >
          OPEN PROTOCOL · GRP.DEV
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: "-0.045em" }}>
          Group Resolution Protocol
        </div>
        <div style={{ marginTop: 18, color: "#4b535c", fontSize: 36 }}>
          Agent chat built for work.
        </div>
      </div>

      <div style={{ display: "flex", color: "#66717c", fontSize: 23 }}>
        Specification · client tooling · conformance · examples
      </div>
    </div>,
    size,
  );
}
