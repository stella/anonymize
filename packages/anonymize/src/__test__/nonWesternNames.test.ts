import { describe, expect, test } from "bun:test";
import {
  createPipelineContext,
  runPipeline,
  detectNameCorpus,
  initNameCorpus,
} from "../index";
import type { Entity, PipelineConfig } from "../types";

// ── Helpers ────────────────────────────────────────────────────────

const baseConfig: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["person"],
  workspaceId: "non-western-test",
};

const detect = async (text: string): Promise<Entity[]> => {
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: baseConfig,
    gazetteerEntries: [],
    context,
  });
};

const detectWithConfig = async (
  text: string,
  config: PipelineConfig,
): Promise<Entity[]> => {
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config,
    gazetteerEntries: [],
    context,
  });
};

const detectWithDenyList = async (text: string): Promise<Entity[]> => {
  return detectWithConfig(text, { ...baseConfig, enableDenyList: true });
};

/** Direct detector call; returns raw entities without pipeline post-processing. */
const directCtx = createPipelineContext();
let directCtxReady = false;
const ensureDirectCtx = async (): Promise<void> => {
  if (!directCtxReady) {
    await initNameCorpus(directCtx);
    directCtxReady = true;
  }
};
const detectDirect = async (text: string): Promise<Entity[]> => {
  await ensureDirectCtx();
  return detectNameCorpus(text, directCtx);
};

const persons = (entities: Entity[]): Entity[] =>
  entities.filter((e) => e.label === "person");

// ── Tests ──────────────────────────────────────────────────────────

describe("Non-Western Name Detection", () => {
  // ── India ──────────────────────────────────────────────────────────
  describe("India", () => {
    test("initials + surname (R. K. Narayan)", async () => {
      const matches = persons(
        await detect("The book was written by R. K. Narayan yesterday."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("R. K. Narayan");
    });

    test("honorific (Shri Amit Shah)", async () => {
      const matches = persons(
        await detect("We welcomed Shri Amit Shah to the stage."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Shri Amit Shah");
    });

    test("honorific with dot (Smt. Smriti Irani)", async () => {
      const matches = persons(
        await detect("A speech was delivered by Smt. Smriti Irani."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Smt. Smriti Irani");
    });

    test("honorific and dotted initials (Dr. A.P.J. Abdul Kalam)", async () => {
      const matches = persons(
        await detect(
          "The late President Dr. A.P.J. Abdul Kalam was a scientist.",
        ),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toContain("A.P.J. Abdul Kalam");
    });

    test("two non-Western tokens (Rahul Sharma)", async () => {
      const matches = persons(
        await detect("Rahul Sharma attended the hearing."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Rahul Sharma");
    });

    test("Goan Catholic surname with apostrophe (Fernandes D'Souza)", async () => {
      const matches = persons(
        await detect("Fernandes D'Souza filed the appeal."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toContain("D'Souza");
    });

    test("Assamese surname with title (Dr. Baruah)", async () => {
      const matches = persons(
        await detect("Dr. Baruah presented the findings."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toContain("Baruah");
    });

    test("Sindhi surname chain (Lal Advani)", async () => {
      const matches = persons(
        await detect("Lal Advani testified before the committee."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Lal Advani");
    });

    test("Kutchi name (Darshan Chheda)", async () => {
      const matches = persons(
        await detect("The agreement was signed by Darshan Chheda."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Darshan Chheda");
    });
  });

  // ── UAE / Saudi Arabia ─────────────────────────────────────────────
  describe("UAE / Saudi Arabia", () => {
    test("Al- prefix (Mohammed Al-Rashid)", async () => {
      const matches = persons(
        await detect("Please contact Mohammed Al-Rashid for the report."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Mohammed Al-Rashid");
    });

    test("bint patronymic (Fatima bint Abdullah)", async () => {
      const matches = persons(
        await detect("The inheritance of Fatima bint Abdullah was settled."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Fatima bint Abdullah");
    });

    test("Sheikh honorific (Sheikh Hamdan)", async () => {
      const matches = persons(await detect("We met Sheikh Hamdan in Dubai."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Sheikh Hamdan");
    });

    test("bin patronymic with title (Dr. Omar bin Khalid)", async () => {
      const matches = persons(
        await detect("The clinic is managed by Dr. Omar bin Khalid."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toContain("Omar bin Khalid");
    });

    test("Gulf ruling family name (Mohammed AlMaktoum)", async () => {
      const matches = persons(
        await detect("Mohammed AlMaktoum chaired the session."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Mohammed AlMaktoum");
    });
  });

  // ── Singapore / Malaysia ───────────────────────────────────────────
  describe("Singapore / Malaysia", () => {
    test("Chinese surnames in Latin (Tan Kah Kee)", async () => {
      const matches = persons(
        await detect("The local school was founded by Tan Kah Kee."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Tan Kah Kee");
    });
  });

  // ── Hong Kong / CJK ────────────────────────────────────────────────
  describe("Hong Kong / CJK", () => {
    test("CJK characters (張小明)", async () => {
      const matches = persons(await detect("The director signed as 張小明."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("張小明");
    });

    test("Japanese Han name (田中太郎)", async () => {
      const matches = persons(await detect("The director signed as 田中太郎."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("田中太郎");
    });

    test("common CJK non-person terms are ignored", async () => {
      const matches = persons(
        await detect("The document mentions 香港 and 中文."),
      );
      expect(matches.length).toBe(0);
    });

    test("CJK not detected in CJK-majority document", async () => {
      // A document with >15% Han characters should not trigger CJK name detection
      const cjkMajority =
        "這是一份中文合約文本。這是一份中文合約文本。張小明在此簽名。這是一份中文合約文本。這是一份中文合約文本。";
      const matches = persons(await detectDirect(cjkMajority));
      expect(matches.every((m) => m.text !== "張小明")).toBe(true);
    });

    test("single CJK character is ignored (的)", async () => {
      const matches = persons(
        await detect("This is a single character 的 which is a particle."),
      );
      expect(matches.length).toBe(0);
    });

    test("5+ CJK characters are ignored (too long for a name)", async () => {
      const matches = persons(
        await detectDirect("The sign reads 美利坚合众国 here."),
      );
      expect(matches.length).toBe(0);
    });
  });

  // ── Japan ──────────────────────────────────────────────────────────
  describe("Japan", () => {
    test("Hepburn family-first ALL-CAPS (SATO Kenji)", async () => {
      const matches = persons(
        await detect("The lead researcher was SATO Kenji."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("SATO Kenji");
    });

    test("-san suffix (Watanabe-san)", async () => {
      const matches = persons(
        await detect("We sent the document to Watanabe-san."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Watanabe-san");
    });

    test("-sama suffix (Tanaka-sama)", async () => {
      const matches = persons(
        await detect("Tanaka-sama received the invitation."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Tanaka-sama");
    });

    test("-sensei suffix (Suzuki-sensei)", async () => {
      const matches = persons(await detect("Suzuki-sensei taught the class."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Suzuki-sensei");
    });
  });

  // ── South Korea ────────────────────────────────────────────────────
  describe("South Korea", () => {
    test("surname + given name (Kim Minjun)", async () => {
      const matches = persons(
        await detect("The meeting was led by Kim Minjun."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Kim Minjun");
    });

    test("ALL-CAPS surname (PARK Jihoon)", async () => {
      const matches = persons(
        await detect("PARK Jihoon submitted the application."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("PARK Jihoon");
    });

    test("transliteration variant (Yi Seojun)", async () => {
      const matches = persons(await detect("Yi Seojun signed the contract."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Yi Seojun");
    });
  });

  // ── Thailand ───────────────────────────────────────────────────────
  describe("Thailand", () => {
    test("Khun honorific (Khun Somchai)", async () => {
      const matches = persons(
        await detect("Please contact Khun Somchai for details."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Khun Somchai");
    });

    test("given name + surname (Prasert Suwannathat)", async () => {
      const matches = persons(
        await detect("Prasert Suwannathat filed the application."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Prasert Suwannathat");
    });
  });

  // ── Vietnam ────────────────────────────────────────────────────────
  describe("Vietnam", () => {
    test("honorific + name (Ong Nguyen Van Minh)", async () => {
      const matches = persons(
        await detect("Ong Nguyen Van Minh attended the hearing."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Ong Nguyen Van Minh");
    });

    test("surname + middle + given (Tran Thi Mai)", async () => {
      const matches = persons(
        await detect("Tran Thi Mai signed the agreement."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Tran Thi Mai");
    });

    test("common surname chain (Pham Duc Anh)", async () => {
      const matches = persons(
        await detect("Pham Duc Anh was appointed director."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Pham Duc Anh");
    });
  });

  // ── Philippines ────────────────────────────────────────────────────
  describe("Philippines", () => {
    test("Spanish-origin surname (Maria Santos)", async () => {
      const matches = persons(await detect("Maria Santos filed the motion."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Maria Santos");
    });

    test("Chinese-Filipino surname (Roberto Lim)", async () => {
      const matches = persons(
        await detect("Roberto Lim submitted the proposal."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Roberto Lim");
    });
  });

  // ── Indonesia ──────────────────────────────────────────────────────
  describe("Indonesia", () => {
    test("Javanese name (Budi Santoso)", async () => {
      const matches = persons(
        await detect("Budi Santoso manages the project."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Budi Santoso");
    });

    test("Batak clan name (Rahmat Nasution)", async () => {
      const matches = persons(
        await detect("Rahmat Nasution joined the board."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Rahmat Nasution");
    });

    test("Balinese birth-order name (Wayan Kusuma)", async () => {
      const matches = persons(await detect("Wayan Kusuma signed the deed."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Wayan Kusuma");
    });
  });

  // ── Scoring & chain logic (direct detector) ────────────────────────
  describe("Scoring and chain logic", () => {
    test("title + non-Western token scores 0.95", async () => {
      const matches = persons(await detectDirect("Shri Amit arrived."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.95);
    });

    test("two non-Western tokens score 0.9", async () => {
      const matches = persons(await detectDirect("Rahul Sharma spoke."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.9);
    });

    test("non-Western token + capitalized scores 0.9", async () => {
      const matches = persons(await detectDirect("Singh Raghav testified."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.9);
    });

    test("Arabic connector + non-Western token scores 0.9", async () => {
      const matches = persons(await detectDirect("Omar bin Khalid arrived."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.9);
    });

    test("Japanese suffix + capitalized scores 0.9", async () => {
      const matches = persons(await detectDirect("Watanabe-san left early."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.9);
    });

    test("standalone non-Western token mid-sentence scores 0.5", async () => {
      const matches = persons(
        await detectDirect("The witness Singh testified."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.5);
    });

    test("standalone non-Western token at sentence start is skipped", async () => {
      const matches = persons(await detectDirect("Singh is a common surname."));
      expect(matches.length).toBe(0);
    });

    test("ALL-CAPS surname that is also in name tokens scores as two non-Western tokens (0.9)", async () => {
      // "SATO" titleCased→"Sato" matches the non-Western name corpus, so it
      // is classified as NAME with nonWestern=true. Two nonWestern tokens
      // → score 0.9.
      const matches = persons(await detectDirect("SATO Kenji presented."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.9);
    });

    test("ALL-CAPS non-name word + non-Western token in mixed-case text", async () => {
      // "SMITH" is all-caps in mixed-case text → OTHER (not in any
      // corpus and not in a signature-block all-caps line). "Kenji"
      // alone is a standalone non-Western token mid-sentence → 0.5.
      const matches = persons(await detectDirect("SMITH Kenji presented."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.score).toBe(0.5);
    });

    test("chain without any non-Western anchor is skipped", async () => {
      const matches = persons(
        await detectDirect("Apple Banana Carrot for lunch."),
      );
      expect(matches.length).toBe(0);
    });

    test("ALL-CAPS without a non-Western name token is skipped", async () => {
      const matches = persons(await detectDirect("THE AGREEMENT is binding."));
      expect(matches.length).toBe(0);
    });
  });

  // ── Chain boundary rules ───────────────────────────────────────────
  describe("Chain boundary rules", () => {
    test("chain breaks on semicolon", async () => {
      const matches = persons(
        await detectDirect("Rahul Sharma; the witness left."),
      );
      // "Rahul Sharma" should be one entity, not extended past the semicolon
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Rahul Sharma");
    });

    test("chain breaks on question mark", async () => {
      const matches = persons(
        await detectDirect("Rahul Sharma? Yes, he confirmed."),
      );
      expect(matches.some((m) => m.text === "Rahul Sharma")).toBe(true);
    });

    test("chain breaks on newline", async () => {
      const matches = persons(
        await detectDirect("Rahul Sharma\nThe witness left."),
      );
      expect(matches.some((m) => m.text === "Rahul Sharma")).toBe(true);
    });

    test("chain respects MAX_CHAIN=5 limit", async () => {
      // Six non-Western name tokens; the first chain caps at 5, the 6th
      // starts a standalone chain (score 0.5).
      const matches = persons(
        await detectDirect("Singh Rahul Vijay Arun Suresh Kumar arrived."),
      );
      expect(matches.length).toBeGreaterThanOrEqual(1);
      // The longest match must have at most 5 words
      let longest = matches[0]; // SAFETY: length >= 1
      for (const m of matches) {
        if (m.end - m.start > longest.end - longest.start) longest = m;
      }
      expect(longest.text.split(" ").length).toBeLessThanOrEqual(5);
    });

    test("chain breaks on period that is not an initial continuation", async () => {
      const matches = persons(await detectDirect("Rahul Sharma. He left."));
      expect(matches.some((m) => m.text === "Rahul Sharma")).toBe(true);
    });

    test("period after title does not break chain", async () => {
      const matches = persons(await detectDirect("Dr. Singh testified."));
      expect(matches.some((m) => m.text.includes("Singh"))).toBe(true);
    });

    test("Japanese suffix attaches via hyphen or space", async () => {
      // Both hyphenated and spaced forms are valid in Japanese text.
      const hyphenated = persons(await detectDirect("Tanaka-sensei taught."));
      const spaced = persons(await detectDirect("Tanaka sensei taught."));
      expect(hyphenated.some((m) => m.text === "Tanaka-sensei")).toBe(true);
      expect(spaced.some((m) => m.text.includes("Tanaka"))).toBe(true);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────
  describe("Deduplication", () => {
    test("overlapping spans are deduplicated (first wins)", async () => {
      const matches = persons(await detectDirect("Singh Rahul Sharma spoke."));
      // Should produce one non-overlapping entity, not two overlapping ones
      const starts = matches.map((m) => m.start);
      const ends = matches.map((m) => m.end);
      for (let i = 0; i < matches.length; i++) {
        for (let j = i + 1; j < matches.length; j++) {
          const overlaps = starts[i] < ends[j] && ends[i] > starts[j];
          expect(overlaps).toBe(false);
        }
      }
    });
  });

  // ── Negative cases (false positive mitigations) ────────────────────
  describe("False positive mitigations", () => {
    test("common English words are not detected as names", async () => {
      const matches = persons(
        await detect("We ordered Apple Banana Carrot for the kitchen."),
      );
      expect(matches.length).toBe(0);
    });

    test("lowercase al- is not a name", async () => {
      const matches = persons(
        await detect("This is just some al-prose that is not a name."),
      );
      expect(matches.length).toBe(0);
    });

    test("single initial does not trigger (U.S. Department)", async () => {
      const matches = persons(
        await detect("The U.S. Department announced new rules."),
      );
      expect(matches.length).toBe(0);
    });

    test("normal capitalized sentence is not a name (The Agreement)", async () => {
      const matches = persons(
        await detect("The Agreement shall be governed by law."),
      );
      expect(matches.length).toBe(0);
    });

    test("organization keyword filter rejects name-like spans", async () => {
      const matches = persons(
        await detect("The services were provided by Tan Analytics, Inc."),
      );
      expect(matches.length).toBe(0);
    });

    test("lowercase short tokens are not matched as names", async () => {
      const matches = persons(await detect("We need to go to the stage."));
      expect(matches.length).toBe(0);
    });

    test("Korean surname at sentence start gets low score", async () => {
      const matches = persons(
        await detect("Kim is a common surname in Korea."),
      );
      expect(matches.every((m) => m.score < 0.6)).toBe(true);
    });

    test("Arabic bin without non-Western token is skipped", async () => {
      const matches = persons(
        await detectDirect("The bin of the device is full."),
      );
      expect(matches.every((m) => !m.text.includes("bin"))).toBe(true);
    });

    test("WERE in all-caps is excluded", async () => {
      const matches = persons(
        await detectDirect("THEY WERE ADVISED OF THE TERMS."),
      );
      // "WERE" should not be classified as ALL_CAPS person token
      expect(matches.every((m) => !m.text.includes("WERE"))).toBe(true);
    });

    test("common English word 'more' is not a name", async () => {
      const matches = persons(await detect("For more information, see below."));
      expect(matches.length).toBe(0);
    });

    test("bare 'HE' is not a title (Gulf honorific FP)", async () => {
      const matches = persons(
        await detect("HE Said that the contract was signed."),
      );
      expect(matches.every((m) => m.text !== "HE Said")).toBe(true);
    });

    test("full-word title does not chain across sentence period", async () => {
      const matches = persons(
        await detect(
          "The presiding officer was Justice. Kumar filed the appeal.",
        ),
      );
      expect(matches.every((m) => !m.text.includes("Justice. Kumar"))).toBe(
        true,
      );
    });

    test("title-only deny-list hits are not extended into person spans", async () => {
      const matches = persons(
        await detectWithDenyList(
          "The Hon'ble Court considered the appeal. Ong Agreement followed.",
        ),
      );
      expect(matches.length).toBe(0);
    });

    test("deny-list mode keeps supplemental CJK name detection", async () => {
      const matches = persons(await detectWithDenyList("Signed by 田中太郎."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("田中太郎");
    });

    test("deny-list mode keeps CJK non-person terms suppressed", async () => {
      const matches = persons(
        await detectWithDenyList("The document mentions 香港 and 中文."),
      );
      expect(matches.length).toBe(0);
    });

    test("deny-list mode keeps high-evidence non-Western chains", async () => {
      const matches = persons(
        await detectWithDenyList("The lead researcher was SATO Kenji."),
      );
      expect(matches.some((m) => m.text === "SATO Kenji")).toBe(true);
    });

    test("deny-list supplemental mode does not emit bare non-Western tokens", async () => {
      const matches = persons(
        await detectWithDenyList("The witness Sato testified."),
      );
      expect(matches.length).toBe(0);
    });

    test("deny-list mode keeps ordinary Western names on deny-list path", async () => {
      const matches = persons(await detectWithDenyList("John Smith signed."));
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("John Smith");
      expect(matches[0]?.source).toBe("deny-list");
    });
  });

  // ── Offset accuracy ────────────────────────────────────────────────
  describe("Offset accuracy", () => {
    test("entity text matches the slice at its offsets", async () => {
      const text = "Please forward this to Rahul Sharma immediately.";
      const matches = persons(await detect(text));
      const match = matches.find((m) => m.text === "Rahul Sharma");
      expect(match).toBeDefined();
      if (match) {
        expect(text.slice(match.start, match.end)).toBe(match.text);
      }
    });

    test("CJK entity offsets are accurate", async () => {
      const text = "Signed by 張小明 on Tuesday.";
      const matches = persons(await detect(text));
      const match = matches.find((m) => m.text === "張小明");
      expect(match).toBeDefined();
      if (match) {
        expect(text.slice(match.start, match.end)).toBe(match.text);
      }
    });

    test("honorific entity offsets are accurate", async () => {
      const text = "The guest was Shri Amit Shah.";
      const matches = persons(await detect(text));
      const match = matches.find((m) => m.text === "Shri Amit Shah");
      expect(match).toBeDefined();
      if (match) {
        expect(text.slice(match.start, match.end)).toBe(match.text);
      }
    });
  });

  // ── Relational & Post-Nominals ─────────────────────────────────────
  describe("Relational & Post-Nominals", () => {
    test("India/Singapore s/o relational connector", async () => {
      const matches = persons(
        await detect("Rahul Kumar s/o Vikram Kumar signed the declaration."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Rahul Kumar s/o Vikram Kumar");
    });

    test("Indonesian post-nominal title S.H.", async () => {
      const matches = persons(
        await detect("This case was prepared by Budi Santoso S.H."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Budi Santoso S.H");
    });

    test("Hong Kong post-nominal title JP", async () => {
      const matches = persons(
        await detect("The statement was witnessed by Wong JP."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Wong JP");
    });

    test("Philippine prefix Atty.", async () => {
      const matches = persons(
        await detect("Please contact Atty. Maria Santos."),
      );
      expect(matches.length).toBe(1);
      expect(matches[0]?.text).toBe("Atty. Maria Santos");
    });
  });

  // ── Pipeline integration ───────────────────────────────────────────
  describe("Pipeline integration", () => {
    test("non-Western and Western detectors coexist without duplicate spans", async () => {
      // "Rahul" is in both the Western name corpus and the non-Western token list.
      // The pipeline's mergeAndDedup should produce exactly one person entity.
      const matches = persons(
        await detect("Rahul Sharma signed the document."),
      );
      const rahulMatches = matches.filter((m) => m.text === "Rahul Sharma");
      expect(rahulMatches.length).toBe(1);
    });

    test("disabling name corpus disables non-Western detection", async () => {
      const noCorpusConfig: PipelineConfig = {
        ...baseConfig,
        enableNameCorpus: false,
      };
      const matches = persons(
        await detectWithConfig(
          "Rahul Sharma signed the document.",
          noCorpusConfig,
        ),
      );
      // With name corpus disabled, the non-Western detector should not fire
      expect(matches.every((m) => m.text !== "Rahul Sharma")).toBe(true);
    });

    test("nameCorpusLanguages scopes built-in non-Western names", async () => {
      const csMatches = persons(
        await detectWithConfig("The witness Sato testified.", {
          ...baseConfig,
          nameCorpusLanguages: ["cs"],
        }),
      );
      const jaMatches = persons(
        await detectWithConfig("The witness Sato testified.", {
          ...baseConfig,
          nameCorpusLanguages: ["ja-latn"],
        }),
      );

      expect(csMatches.length).toBe(0);
      expect(jaMatches.some((m) => m.text === "Sato")).toBe(true);
    });

    test("nameCorpusLanguages scopes non-Western honorifics", async () => {
      const csMatches = persons(
        await detectWithConfig("Ong Nguyen Van Minh attended the hearing.", {
          ...baseConfig,
          nameCorpusLanguages: ["cs"],
        }),
      );
      const viMatches = persons(
        await detectWithConfig("Ong Nguyen Van Minh attended the hearing.", {
          ...baseConfig,
          nameCorpusLanguages: ["vi"],
        }),
      );

      expect(csMatches.every((m) => m.text !== "Ong Nguyen Van Minh")).toBe(
        true,
      );
      expect(viMatches.some((m) => m.text === "Ong Nguyen Van Minh")).toBe(
        true,
      );
    });
  });

  // ── Common-word collisions ─────────────────────────────────────────
  // Some non-Western given names coincide with everyday English words
  // ("Loan" is both a Vietnamese name and the noun). A capitalized
  // phrase made entirely of such common words ("Loan Documents", "Loan
  // Amount") is a defined term, not a person, and must not be chained
  // into a person span on the strength of a single ambiguous token.
  describe("common-word collisions", () => {
    test("does not flag a common-word phrase as a person (Loan Documents)", async () => {
      const matches = persons(
        await detect(
          "All warranties contained in the Loan Documents are true and correct.",
        ),
      );
      expect(matches.some((m) => m.text.includes("Loan"))).toBe(false);
    });

    test("does not flag Loan Amount as a person", async () => {
      const matches = persons(
        await detect("The numerator is the Maximum Loan Amount for the asset."),
      );
      expect(matches.some((m) => m.text.includes("Loan"))).toBe(false);
    });

    test("still detects a genuine name sharing the ambiguous token (Loan Nguyen)", async () => {
      const matches = persons(
        await detect("The lease was signed by Loan Nguyen last week."),
      );
      expect(matches.some((m) => m.text === "Loan Nguyen")).toBe(true);
    });
  });
});
