import { signCompactJws } from "@grp-protocol/audit";
import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  GrpClient,
  GrpError,
  SDK_VERSION,
  publicKeyFromJwks,
  receiptKid,
  verifyCompactReceipt,
  verifyRoomReceiptChain,
} from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("@grp-protocol/sdk", () => {
  it("does not echo query credentials in transport errors", async () => {
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      fetch: async () => {
        throw new Error("network down");
      },
    });

    let thrown: unknown;
    try {
      await client.getRoom("abc123", "t_do-not-print-me");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "request failed for https://operator.example/api/rooms/abc123",
    );
    expect((thrown as Error).message).not.toContain("t_do-not-print-me");
  });

  it("times out a transport that never settles", async () => {
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      requestTimeoutMs: 10,
      fetch: () => new Promise<Response>(() => {}),
    });

    await expect(client.discover()).rejects.toMatchObject({
      name: "GrpTransportError",
      message: "request failed for https://operator.example/.well-known/grp.json",
    });
  });

  it("refuses redirects instead of forwarding credentials", async () => {
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_secret",
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        }),
    });

    await expect(client.getRoom("abc123")).rejects.toMatchObject({
      name: "GrpTransportError",
    });
  });

  it("rejects oversized response bodies before parsing", async () => {
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      maxResponseBytes: 32,
      fetch: async () => jsonResponse({ payload: "x".repeat(100) }),
    });

    await expect(client.discover()).rejects.toMatchObject({
      name: "GrpTransportError",
    });
  });

  it("constructs create/join/choose requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (request.url.endsWith("/api/rooms")) {
          return jsonResponse({
            slug: "abc123",
            url: "https://operator.example/r/abc123",
            creator_token: "t_creator",
            voting_ends_at: "2026-05-27T00:00:00Z",
            config: {},
            owner_principal_id: null,
            expires_at: null,
          });
        }
        if (request.url.endsWith("/join")) {
          return jsonResponse({ participant_id: "p1", participant_token: "t_p1" });
        }
        if (request.url.endsWith("/choose")) {
          return jsonResponse({
            ok: true,
            slug: "abc123",
            cast_choice: "yes",
            status: "resolved",
            resolved_winner: "yes",
            resolved_outcome: "completed",
          });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      },
    });

    await client.createRoom({ question: "Approve?", options: ["yes", "no"] });
    await client.joinRoom({ slug: "abc123", display_name: "agent" });
    await client.choose({ slug: "abc123", choice: "yes" });

    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/rooms",
      "/api/rooms/abc123/join",
      "/api/rooms/abc123/choose",
    ]);
    expect(await requests[2]?.json()).toEqual({ choice: "yes" });
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer t_default");
  });

  it("constructs room-first create requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          slug: "abc123",
          url: "https://operator.example/r/abc123",
          creator_token: "t_creator",
          about: "Planning Friday dinner",
          voting_ends_at: null,
          config: { type: "persistent" },
          owner_principal_id: null,
          expires_at: null,
        });
      },
    });

    const created = await client.createRoom({ about: "Planning Friday dinner" });
    expect(created.voting_ends_at).toBeNull();
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/rooms");
    expect(await requests[0]?.json()).toEqual({ about: "Planning Friday dinner" });
  });

  it("sends hosted auth as bearer plus mandate headers", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      accessToken: "rk_secret",
      mandate: "mandate.jws",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          participant_id: "p1",
          participant_token: null,
          agent_did: "urn:agent:alex",
        });
      },
    });

    await client.joinRoom({ slug: "abc123", invite: "it_invite" });

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rk_secret");
    expect(requests[0]?.headers.get("x-mandate")).toBe("mandate.jws");
    expect(await requests[0]?.json()).toEqual({ invite: "it_invite" });
  });

  it("sends a Private-room password on every read surface", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse(
          request.url.endsWith("/events")
            ? { slug: "abc123", events: [] }
            : request.url.endsWith("/decisions")
              ? { slug: "abc123", decisions: [] }
              : {},
        );
      },
    });

    await client.getRoom("abc123", undefined, "shared-secret");
    await client.readDelta("abc123", 4, undefined, "shared-secret");
    await client.listDecisions("abc123", undefined, "shared-secret");
    await client.outcome("abc123", undefined, "shared-secret");
    await client.listEvents({ slug: "abc123", password: "shared-secret" });

    expect(requests).toHaveLength(5);
    expect(
      requests.every((request) => request.headers.get("x-room-password") === "shared-secret"),
    ).toBe(true);
  });

  it("constructs room settings update requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          slug: "abc123",
          changed: ["quorum"],
          config: { quorum: 4 },
        });
      },
    });

    const updated = await client.updateRoomSettings({
      slug: "abc123",
      settings: { quorum: 4 },
    });

    expect(updated.changed).toEqual(["quorum"]);
    expect(requests[0]?.method).toBe("PATCH");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/rooms/abc123/settings");
    expect(await requests[0]?.json()).toEqual({
      settings: { quorum: 4 },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_default");
  });

  it("constructs bound invite requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          slug: "abc123",
          invite: {
            code: "inv_alex",
            label: "Alex",
            role: "participant",
            expected: true,
            status: "pending",
            binding: { kind: "principal", value: "https://principals.example/alex" },
          },
          invite_token: "it_alex",
          join_url: "https://operator.example/r/abc123?invite=it_alex",
          join_command: "grp join abc123 --invite it_alex",
        });
      },
    });

    await client.createInvite({
      slug: "abc123",
      label: "Alex",
      // Spec 106 — the binding object is the one binding input shape.
      binding: { kind: "principal", value: "https://principals.example/alex" },
    });

    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/rooms/abc123/invites");
    expect(await requests[0]?.json()).toEqual({
      label: "Alex",
      binding: { kind: "principal", value: "https://principals.example/alex" },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_default");
  });

  it("submits choices through the preferred choose alias", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          ok: true,
          slug: "abc123",
          cast_choice: "yes",
          status: "resolved",
          resolved_winner: "yes",
          resolved_outcome: "completed",
        });
      },
    });

    await client.choose({ slug: "abc123", choice: "yes", reason: "Best fit." });

    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/rooms/abc123/choose");
    expect(await requests[0]?.json()).toMatchObject({
      choice: "yes",
      rationale: "Best fit.",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_default");
  });

  it("constructs deliberate abstention requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return jsonResponse({
          ok: true,
          slug: "abc123",
          abstained: true,
          reason: "Conflict of interest",
          resolved_winner: null,
          resolved_outcome: null,
        });
      },
    });

    await client.abstain({
      slug: "abc123",
      reason: "Conflict of interest",
      decision: 2,
    });

    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/rooms/abc123/abstain");
    expect(await requests[0]?.json()).toEqual({
      reason: "Conflict of interest",
      decision: 2,
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t_default");
  });

  it("constructs slate and conclusion requests", async () => {
    const requests: Request[] = [];
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      token: "t_default",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (request.url.endsWith("/ask")) {
          return jsonResponse({
            ok: true,
            slug: "abc123",
            decision: {
              id: "d1",
              seq: 1,
              question: "Which move?",
              context: null,
              options: [],
              voting_opens_at: "2026-05-27T00:05:00Z",
              voting_ends_at: "2026-05-27T00:06:00Z",
              prev_hash: null,
              status: "proposing",
            },
          });
        }
        if (request.url.endsWith("/start-choosing")) {
          return jsonResponse({
            ok: true,
            slug: "abc123",
            decision: {
              id: "d1",
              seq: 1,
              options: ["a"],
              voting_opens_at: "2026-05-27T00:00:00Z",
              voting_ends_at: "2026-05-27T00:01:00Z",
              status: "voting",
            },
          });
        }
        if (request.url.endsWith("/close")) {
          return jsonResponse({
            ok: true,
            slug: "abc123",
            concluded_at: "2026-05-27T00:02:00Z",
            receipt_hash: "sha256:abc",
            prev_hash: "sha256:prev",
          });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      },
    });

    await client.ask({
      slug: "abc123",
      question: "Which move?",
      options: [],
      voting_window: 60,
      proposal_window: 300,
      agreement: true,
    });
    await client.startChoosing({ slug: "abc123", decision_id: "d1" });
    await client.closeRoom({ slug: "abc123", statement: "finished" });

    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/rooms/abc123/ask",
      "/api/rooms/abc123/start-choosing",
      "/api/rooms/abc123/close",
    ]);
    expect(await requests[0]?.json()).toMatchObject({
      voting_window: 60,
      proposal_window: 300,
      agreement: true,
    });
    expect(await requests[1]?.json()).toEqual({ decision_id: "d1" });
    expect(await requests[2]?.json()).toEqual({ statement: "finished" });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer t_default");
    }
  });

  it("sends mandate auth in X-Mandate", async () => {
    let mandateHeader: string | null = null;
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      mandate: "signed-mandate",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        mandateHeader = request.headers.get("x-mandate");
        return jsonResponse({ ok: true, id: "d1" });
      },
    });

    await client.discuss({ slug: "abc123", body: "Looks good." });
    expect(mandateHeader).toBe("signed-mandate");
  });

  it("throws typed protocol errors", async () => {
    const client = new GrpClient({
      baseUrl: "https://operator.example",
      fetch: async () => jsonResponse({ error: "invalid token for this room" }, 401),
    });

    await expect(client.getRoom("abc123")).rejects.toMatchObject({
      name: "GrpError",
      code: "invalid token for this room",
      status: 401,
    });
  });

  it("verifies current URL-room receipt chains", () => {
    const valid = verifyRoomReceiptChain({
      slug: "abc123",
      question: "Approve?",
      options: ["yes", "no"],
      status: "resolved",
      resolved_at: "2026-05-27T00:00:00Z",
      resolved_outcome: "completed",
      resolved_winner: "yes",
      resolution_payload: null,
      created_at: "2026-05-27T00:00:00Z",
      decisions: [
        {
          seq: 1,
          question: "A?",
          resolved_winner: "yes",
          prev_hash: null,
          receipt_hash: "sha256:a",
        },
        {
          seq: 2,
          question: "B?",
          resolved_winner: "yes",
          prev_hash: "sha256:a",
          receipt_hash: "sha256:b",
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = verifyRoomReceiptChain({
      slug: "abc123",
      question: "Approve?",
      options: ["yes", "no"],
      status: "resolved",
      resolved_at: "2026-05-27T00:00:00Z",
      resolved_outcome: "completed",
      resolved_winner: "yes",
      resolution_payload: null,
      created_at: "2026-05-27T00:00:00Z",
      decisions: [
        {
          seq: 1,
          question: "A?",
          resolved_winner: "yes",
          prev_hash: null,
          receipt_hash: "sha256:a",
        },
        {
          seq: 2,
          question: "B?",
          resolved_winner: "yes",
          prev_hash: "sha256:wrong",
          receipt_hash: "sha256:b",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]).toContain("did not match");
  });

  it("verifies compact JWS receipts when supplied", async () => {
    const privateKey = new Uint8Array(32).fill(2);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const jws = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "room-key" },
      payload: { iss: "room", aud: "room", jti: "r1", iat: 1, grp: { sequence: 1 } },
      privateKey,
    });
    const publicFromJwks = publicKeyFromJwks(
      {
        keys: [
          {
            kid: "room-key",
            kty: "OKP",
            crv: "Ed25519",
            alg: "EdDSA",
            x: Buffer.from(publicKey).toString("base64url"),
          },
        ],
      },
      "room-key",
    );

    expect(receiptKid(jws)).toBe("room-key");
    await expect(verifyCompactReceipt({ jws, publicKey: publicFromJwks })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      verifyCompactReceipt({ jws, publicKey: publicFromJwks, expectedHash: "sha256:bad" }),
    ).rejects.toBeInstanceOf(GrpError);

    const parts = jws.split(".");
    await expect(
      verifyCompactReceipt({
        jws: `${parts[0]}.${parts[1]}.${parts[2]}=`,
        publicKey: publicFromJwks,
      }),
    ).rejects.toMatchObject({ code: "jws.bad_shape" });
    await expect(
      verifyCompactReceipt({ jws: `${jws}.extra`, publicKey: publicFromJwks }),
    ).rejects.toMatchObject({ code: "jws.bad_shape" });

    const critical = await signCompactJws({
      header: { alg: "EdDSA", typ: "grp-receipt+jwt", kid: "room-key", crit: ["future"] },
      payload: { iss: "room", aud: "room", jti: "r2", iat: 1, grp: { sequence: 2 } },
      privateKey,
    });
    await expect(
      verifyCompactReceipt({ jws: critical, publicKey: publicFromJwks }),
    ).rejects.toMatchObject({ code: "jws.critical_header_unsupported" });
  });
});
