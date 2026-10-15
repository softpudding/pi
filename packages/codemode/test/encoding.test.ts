import { describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

describe("standard text encoding in the VM", () => {
	it("encodes Unicode and decodes byte chunks across character boundaries", async () => {
		const sandbox = new CodemodeSandbox();
		try {
			const result = await sandbox.execute(`
        const input = "ASCII 中文 𝄞";
        const bytes = new TextEncoder().encode(input);
        const decoder = new TextDecoder("utf-8", {fatal:true});
        let text = "";
        for (const byte of bytes) text += decoder.decode(new Uint8Array([byte]), {stream:true});
        text += decoder.decode();
        return {text,bytes:Array.from(bytes),encoding:decoder.encoding};
      `);
			expect(result).toMatchObject({
				ok: true,
				value: { text: "ASCII 中文 𝄞", bytes: [...Buffer.from("ASCII 中文 𝄞")], encoding: "utf-8" },
			});
		} finally {
			await sandbox.close();
		}
	});
	it("keeps decoding state inside the VM and supports invalid input handling and views", async () => {
		const sandbox = new CodemodeSandbox();
		try {
			const result = await sandbox.execute(`
        const bytes = new Uint8Array([0,239,187,191,65,0]);
        const view = new DataView(bytes.buffer,1,4);
        const bom = new TextDecoder().decode(view);
        const replacement = new TextDecoder().decode(new Uint8Array([255]));
        let error;
        try {new TextDecoder("utf-8",{fatal:true}).decode(new Uint8Array([255]));} catch(e) {error=e.name;}
        return {bom,replacement,error,frozen:Object.isFrozen(TextDecoder.prototype)};
      `);
			expect(result).toMatchObject({
				ok: true,
				value: { bom: "A", replacement: "�", error: "TypeError", frozen: true },
			});
		} finally {
			await sandbox.close();
		}
	});
});
