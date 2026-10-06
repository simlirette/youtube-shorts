import type { ProviderContext } from '../interfaces.js';
import { RawCompletion, StructuredLLMBase } from '../llm-base.js';

const TOPIC_POOL = [
  { title: 'Why the Millennium Bridge Wobbled on Opening Day', premise: 'London opened a new footbridge in 2000 and closed it two days later because walkers made it sway.', pillar: 'ENGINEERING', tags: ['bridge', 'london', 'resonance'] },
  { title: 'The Molasses Flood That Swept Through Boston', premise: 'A storage tank burst in 1919 and released a wave of molasses through a Boston neighborhood.', pillar: 'STRANGE_REAL_WORLD', tags: ['boston', 'disaster'] },
  { title: 'How a Unit Mix-Up Destroyed a Mars Orbiter', premise: 'A navigation team used imperial units while another used metric, and the spacecraft was lost.', pillar: 'SCIENCE', tags: ['space', 'nasa'] },
  { title: 'The Citicorp Tower Flaw Fixed in Secret', premise: 'An engineering student question revealed a skyscraper could topple in strong winds.', pillar: 'ENGINEERING', tags: ['skyscraper', 'wind'] },
  { title: 'The Coca-Cola Formula Change That Backfired', premise: 'In 1985 Coca-Cola replaced its recipe and reversed course within three months.', pillar: 'BUSINESS', tags: ['marketing', 'soda'] },
  { title: 'How the Hyatt Regency Walkway Design Change Failed', premise: 'A late change to a hanger rod connection doubled the load it had to carry.', pillar: 'ENGINEERING', tags: ['structures'] },
  { title: 'The Leaning Tower of Pisa Stabilization Project', premise: 'Engineers removed soil from under the tower to reduce its lean without toppling it.', pillar: 'ENGINEERING', tags: ['tower', 'soil'] },
  { title: 'Why the Vasa Warship Sank on Its Maiden Voyage', premise: 'A top-heavy Swedish warship capsized within minutes of leaving the harbor in 1628.', pillar: 'STRANGE_REAL_WORLD', tags: ['ship', 'history'] },
  { title: 'The Accidental Discovery of Penicillin Mold', premise: 'A contaminated culture dish revealed a mold that stopped bacteria from growing.', pillar: 'SCIENCE', tags: ['medicine'] },
  { title: 'How Sony Lost the Videotape Format War', premise: 'Betamax had a head start but VHS won on recording time and licensing.', pillar: 'TECHNOLOGY', tags: ['video', 'format war'] },
  { title: 'The Great Stink That Forced London Sewers', premise: 'A hot summer made the Thames smell so bad that Parliament funded a sewer network.', pillar: 'STRANGE_REAL_WORLD', tags: ['london', 'sanitation'] },
  { title: 'How the Apollo Thirteen Crew Fixed Their Air', premise: 'Engineers on the ground improvised a carbon dioxide filter from spacecraft parts.', pillar: 'SCIENCE', tags: ['space'] },
];

const HOOKS = ['Nobody saw this coming.', 'It failed almost immediately.', 'One detail changed everything.', 'The fix took two years.', 'Engineers were baffled.', 'This should never have happened.'];

const FILLER =
  'Nobody expected the crowd itself to become the problem. Every step pushed a little harder, and the motion fed on itself. ' +
  'It was a lesson written in steel and footsteps, and engineers around the world took careful notes about what happened next.';

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Deterministic task-routed LLM for mock mode. It reads the same prompts a real model receives and
 * produces contract-conforming JSON (quotes are copied from the provided sources, never invented).
 */
export class MockLLMProvider extends StructuredLLMBase {
  readonly name = 'mock-llm';
  readonly model = 'mock-llm-1';

  constructor(ctx: ProviderContext = {}, private readonly overrides: Partial<Record<string, (prompt: string) => unknown>> = {}) {
    super(ctx);
  }

  protected async complete(_system: string, user: string, o: { task: string; model: string }): Promise<RawCompletion> {
    const override = this.overrides[o.task];
    const content = override ? override(user) : this.route(o.task, user);
    return { text: JSON.stringify(content), inputTokens: Math.ceil(user.length / 4), outputTokens: 200, model: this.model, httpAttempts: 1 };
  }

  private route(task: string, prompt: string): unknown {
    switch (task) {
      case 'discovery': {
        const n = Number(prompt.match(/EXACTLY (\d+)/)?.[1] ?? 3);
        const avoid = prompt.slice(prompt.indexOf('ALREADY USED') >= 0 ? prompt.indexOf('ALREADY USED') : prompt.length).toLowerCase();
        const fresh = TOPIC_POOL.filter((t) => !avoid.includes(t.title.toLowerCase()));
        return { topics: fresh.slice(0, n) };
      }
      case 'scoring':
        return {
          dimensions: {
            curiosity: 8, audiencePotential: 8, originality: 7, storyDepth: 8, visualPotential: 7, sourceAvailability: 9,
            freshness: 6, productionComplexity: 4, copyrightRisk: 1, repetitionRisk: 2, monetizationRisk: 1,
          },
          reasoning: 'Mock assessment: clear conflict, documented sources, safe subject.',
        };
      case 'research_extraction': {
        const blocks = [...prompt.matchAll(/<source id="(S\d+)"[^>]*>([\s\S]*?)<\/source>/g)];
        const claims: unknown[] = [];
        for (const [, ref, body] of blocks) {
          const sentences = body.split(/(?<=\.)\s+/).map((s) => s.trim()).filter((s) => /\d/.test(s) && s.length > 30);
          for (const s of sentences.slice(0, 3)) {
            claims.push({ text: s, entity: 'Millennium Bridge', sourceRef: ref, evidenceQuote: s, isKeyFact: true });
          }
        }
        return {
          summary: 'The Millennium Footbridge swayed on opening, closed, and reopened after dampers were fitted.',
          keyEntities: ['Millennium Bridge', 'Arup'],
          sourceTiers: Object.fromEntries(blocks.map(([, ref]) => [ref, 'REPUTABLE_JOURNALISM'])),
          claims,
          uncertaintyNotes: [],
        };
      }
      case 'claim_entailment': {
        const refs = [...prompt.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]);
        return { results: [...new Set(refs)].map((r) => ({ claimRef: r, verdict: 'SUPPORTED', reason: 'Evidence states the claim directly.' })) };
      }
      case 'story': {
        const topic = prompt.match(/Topic: "([^"]+)"/)?.[1] ?? 'an unexpected engineering story';
        return {
          logline: `The true story behind ${topic}.`,
          centralConflict: 'Human footsteps versus a structure designed for static loads.',
          hookConcept: 'A brand-new bridge defeated by people walking.',
          narrativeArc: {
            hook: 'A new bridge failed in days.',
            context: 'London opened the footbridge in June 2000.',
            development: 'Crowds felt the deck sway sideways.',
            twist: 'Their own synchronized steps caused it.',
            payoff: 'Dampers fixed it and it reopened in 2002.',
          },
        };
      }
      case 'script': {
        const claimLines = [...prompt.matchAll(/\[(C\d+)\]\s+(.+)/g)].map((m) => ({ ref: m[1], text: m[2].trim() }));
        const topicName = prompt.match(/LOGLINE: The true story behind (.+?)\.\n/)?.[1] ?? 'the Footbridge That Swayed';
        const seed = [...topicName].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
        const max = Number(prompt.match(/between (\d+) and (\d+) words/)?.[2] ?? 130);
        const min = Number(prompt.match(/between (\d+) and (\d+) words/)?.[1] ?? 100);
        const pick = (i: number) => claimLines[i % Math.max(1, claimLines.length)];
        const scenes = [
          { narration: HOOKS[seed % HOOKS.length], claimRefs: [] as string[] },
          { narration: pick(0)?.text ?? '', claimRefs: pick(0) ? [pick(0).ref] : [] },
          { narration: pick(1)?.text ?? '', claimRefs: pick(1) ? [pick(1).ref] : [] },
          { narration: pick(2)?.text ?? '', claimRefs: pick(2) ? [pick(2).ref] : [] },
          { narration: pick(3)?.text ?? '', claimRefs: pick(3) ? [pick(3).ref] : [] },
        ];
        // Pad deterministically into the required word range.
        let total = scenes.reduce((n, s) => n + words(s.narration).length, 0);
        const filler = words(FILLER);
        let fi = 0;
        let target = 3;
        while (total < min + 5 && fi < filler.length * 4) {
          scenes[target].narration += ' ' + filler[fi % filler.length];
          fi++;
          total++;
          if (fi % 12 === 0) target = target === 3 ? 4 : 3;
        }
        for (const s of scenes) if (!/[.!?]$/.test(s.narration)) s.narration += '.';
        while (total > max) {
          const w = words(scenes[4].narration);
          w.pop();
          scenes[4].narration = w.join(' ') + '.';
          total--;
        }
        return {
          title: `Inside ${topicName}`.slice(0, 90),
          description: 'How synchronized footsteps closed London’s Millennium Bridge two days after opening.',
          scenes: scenes.map((s, i) => ({
            narration: s.narration,
            visualObjective: 'Pedestrians crossing a modern footbridge over a river',
            assetKeywords: i % 2 === 0 ? ['bridge', 'river', 'city'] : ['people walking', 'crowd', 'footsteps'],
            textOverlay: '',
            claimRefs: s.claimRefs,
          })),
        };
      }
      case 'media_fit': {
        const ids = [...prompt.matchAll(/\[(M\d+)\]/g)].map((m) => m[1]);
        return { fit: ids, unfit: [] };
      }
      case 'media_keywords':
        return { keywords: ['city', 'river', 'people walking', 'sky'] };
      case 'content_review':
        return { findings: [] };
      default:
        throw new Error(`MockLLMProvider has no route for task "${task}"`);
    }
  }
}
