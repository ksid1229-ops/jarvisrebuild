import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import { hashPin } from "./pin.js";

/**
 * pin_verify — the owner enters the 4-digit PIN on a call (spoken or keypad).
 * On success it marks THIS call's session as pin-verified, which the gate then
 * requires before any of the five actions runs on a call. It never reads intent;
 * it only checks digits against the stored hash.
 */
export const pinVerify: Tool = {
  name: "pin_verify",
  description:
    "Verify Sid's 4-digit PIN on a call before a sensitive action. Call it when Sid gives his PIN " +
    "(spoken or typed on the keypad). pin: the four digits. Ordinary calls need no PIN; only the five " +
    "confirmed actions do.",
  parameters: { type: "object", properties: { pin: { type: "string" } }, required: ["pin"] },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.ownerPinVerifier) {
      return { ok: false, status: "not_configured", message: "No owner PIN is configured; sensitive actions on a call are refused." };
    }
    if (ctx.provenance.channel !== "voice" || !ctx.call) {
      return { ok: false, status: "refused", message: "PIN verification only applies on a call." };
    }
    const ok = await ctx.ownerPinVerifier(String(args.pin ?? ""));
    if (!ok) {
      return { ok: false, status: "refused", message: "PIN incorrect." };
    }
    ctx.call.pinVerified = true;
    return { ok: true, status: "ok", message: "PIN verified for this call." };
  },
};

/**
 * call_place — Jarvis calls Sid (e.g. a wake-up decided a call beats a text).
 * This reaches the OWNER, so it is not one of the five actions. Not connected to
 * a real provider yet: it says so.
 *
 * Guard noted for when it is wired: there is no answering-machine detection by
 * default, so a voicemail could receive private replies. Outbound owner calls
 * must gate private content on a confirmed human answer before being relied on.
 */
export const callPlace: Tool = {
  name: "call_place",
  description:
    "Call Sid on the phone (not someone else — that is make_call and needs confirmation). Use when a " +
    "call is better than a text. reason: why you're calling.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  async run(): Promise<ToolResult> {
    return {
      ok: false,
      status: "not_connected",
      message:
        "Outbound calling is not connected to a real provider yet (and needs answering-machine " +
        "detection before it can carry private replies). Nothing was dialed.",
    };
  },
};

export const guestCreate: Tool = {
  name: "guest_create",
  description:
    "Grant a guest limited phone access. name, phone (E.164), access (free text: exactly what they may " +
    "hear/do), expiry (RFC3339 UTC), pin (4 digits for them to enter). The guest gets none of your " +
    "profile or tools.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      phone: { type: "string" },
      access: { type: "string" },
      expiry: { type: "string" },
      pin: { type: "string" },
    },
    required: ["name", "phone", "access", "expiry", "pin"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.guests) return { ok: false, status: "not_connected", message: "Guest registry not wired." };
    const expiry = String(args.expiry ?? "");
    if (Number.isNaN(Date.parse(expiry))) {
      return { ok: false, status: "refused", message: "expiry must be a real RFC3339 instant." };
    }
    const pin = String(args.pin ?? "");
    if (!/^\d{4}$/.test(pin)) return { ok: false, status: "refused", message: "pin must be 4 digits." };
    const pinHash = await hashPin(pin, ctx.pinPepper ?? "");
    const g = await ctx.guests.create({
      name: String(args.name),
      phone: String(args.phone),
      access: String(args.access),
      expiresAt: new Date(expiry).toISOString(),
      pinHash,
    });
    return { ok: true, status: "ok", message: `Guest ${g.name} created (${g.id})`, data: { id: g.id } };
  },
};

export const guestRevoke: Tool = {
  name: "guest_revoke",
  description: "Revoke a guest's access immediately. guest_id from the guest list.",
  parameters: { type: "object", properties: { guest_id: { type: "string" } }, required: ["guest_id"] },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.guests) return { ok: false, status: "not_connected", message: "Guest registry not wired." };
    const ok = await ctx.guests.revoke(String(args.guest_id));
    return ok
      ? { ok: true, status: "ok", message: `Revoked ${args.guest_id}` }
      : { ok: false, status: "refused", message: `No such guest ${args.guest_id}` };
  },
};

export const voiceTools: Tool[] = [pinVerify, callPlace, guestCreate, guestRevoke];
