import { randomUUID } from 'node:crypto';
import {
  TopicCandidate,
  TopicScore,
  ResearchPacket,
  StoryOutline,
  ShortScript,
  ContentPillar,
} from '@shorts/schemas';
import { LLMProvider, LLMGenerateOptions } from '../interfaces.js';

export class MockLLMProvider implements LLMProvider {
  name = 'MockLLMProvider';

  async generateText(prompt: string, _options?: LLMGenerateOptions): Promise<string> {
    return `Mock LLM response for: ${prompt.slice(0, 50)}...`;
  }

  async generateJSON<T>(prompt: string, _schemaDescription: string, _options?: LLMGenerateOptions): Promise<T> {
    return { status: 'mock_json', promptSummary: prompt.slice(0, 30) } as T;
  }

  async generateTopicCandidates(pillar: ContentPillar = 'ENGINEERING', count: number = 3): Promise<TopicCandidate[]> {
    const now = new Date().toISOString();
    const candidates: Record<ContentPillar, Omit<TopicCandidate, 'id' | 'discoveredAt'>[]> = {
      ENGINEERING: [
        {
          title: 'The Millennium Bridge Wobbly Problem',
          premise: 'In 2000, London opened a $25M pedestrian bridge that began swaying violently within hours—not because of wind, but because pedestrians instinctively adjusted their steps in sync with the sway.',
          pillar: 'ENGINEERING',
          sourceUrls: ['https://www.nature.com/articles/35041703', 'https://www.arup.com/projects/millennium-bridge'],
          tags: ['bridges', 'physics', 'synchronous lateral excitation', 'engineering failures'],
          state: 'DISCOVERED',
        },
        {
          title: 'The Soviet Submarine That Saved The World',
          premise: 'During the 1962 Cuban Missile Crisis, Vasili Arkhipov refused to launch a nuclear torpedo despite two other commanding officers voting yes.',
          pillar: 'ENGINEERING',
          sourceUrls: ['https://nsarchive2.gwu.edu/nsa/cuba_mis_cri/'],
          tags: ['cold war', 'submarine', 'nuclear', 'history'],
          state: 'DISCOVERED',
        },
      ],
      BUSINESS: [
        {
          title: 'Why Blockbuster Really Rejected Netflix for $50 Million',
          premise: 'In 2000, Netflix offered to sell itself to Blockbuster for $50M. Blockbuster leadership laughed them out of the boardroom not from arrogance, but because late fees accounted for $800M of their profit.',
          pillar: 'BUSINESS',
          sourceUrls: ['https://hbr.org/2011/04/why-blockbuster-failed'],
          tags: ['netflix', 'blockbuster', 'business strategy', 'disruption'],
          state: 'DISCOVERED',
        },
      ],
      TECHNOLOGY: [
        {
          title: 'The Bug That Nearly Launched World War III in 1983',
          premise: 'Stanislav Petrov received an alert that 5 US nuclear ICBMs were airborne. He deduced it was a false alarm caused by rare sun-cloud reflections detected by Soviet satellite sensors.',
          pillar: 'TECHNOLOGY',
          sourceUrls: ['https://www.armscontrol.org/act/2004-09/features/stanislav-petrov-man-who-averted-nuclear-war'],
          tags: ['satellites', 'false alarms', 'cold war', 'tech flaws'],
          state: 'DISCOVERED',
        },
      ],
      SCIENCE: [
        {
          title: 'The Accidental Discovery of Cosmic Microwave Radiation',
          premise: 'In 1964, Penzias and Wilson detected an inescapable hum in their antenna. They cleaned out pigeon droppings before realizing they were hearing the echo of the Big Bang.',
          pillar: 'SCIENCE',
          sourceUrls: ['https://www.nobelprize.org/prizes/physics/1978/penzias/facts/'],
          tags: ['cosmology', 'astronomy', 'big bang', 'serendipity'],
          state: 'DISCOVERED',
        },
      ],
      STRANGE_REAL_WORLD: [
        {
          title: 'The Great Boston Molasses Flood of 1919',
          premise: 'A 50-foot steel tank burst in Boston, sending a 25-foot wave of hot molasses tearing through streets at 35 miles per hour.',
          pillar: 'STRANGE_REAL_WORLD',
          sourceUrls: ['https://www.scientificamerican.com/article/the-science-of-the-great-molasses-flood/'],
          tags: ['history', 'disasters', 'fluid dynamics', 'bizarre'],
          state: 'DISCOVERED',
        },
      ],
    };

    const pool = candidates[pillar] || candidates.ENGINEERING;
    return pool.slice(0, count).map((item) => ({
      ...item,
      id: randomUUID(),
      discoveredAt: now,
    }));
  }

  async scoreTopic(topic: TopicCandidate): Promise<TopicScore> {
    const isWobblyBridge = topic.title.includes('Bridge') || topic.title.includes('Millennium');
    return {
      id: randomUUID(),
      topicId: topic.id,
      overallScore: isWobblyBridge ? 92 : 88,
      curiosity: 9.5,
      audiencePotential: 9.0,
      originality: 8.8,
      storyDepth: 9.0,
      visualPotential: 9.2,
      sourceAvailability: 9.5,
      freshness: 8.0,
      productionComplexity: 4.0, // balanced
      copyrightRisk: 1.0,        // very safe
      repetitionRisk: 1.5,       // distinct
      monetizationRisk: 0.5,     // clean educational history
      reasoning: 'Highly visual engineering mystery with clear before/after mechanics and universal appeal. Low policy risk.',
      passGate: true,
      scoredAt: new Date().toISOString(),
    };
  }

  async conductResearch(topic: TopicCandidate): Promise<ResearchPacket> {
    const researchId = randomUUID();
    const source1Id = randomUUID();
    const source2Id = randomUUID();
    const claim1Id = randomUUID();
    const claim2Id = randomUUID();
    const claim3Id = randomUUID();

    return {
      id: researchId,
      topicId: topic.id,
      title: topic.title,
      summary: 'Thorough investigation into London Millennium Bridge lateral resonance failure and subsequent damping retrofit.',
      keyEntities: ['London Millennium Bridge', 'Arup Engineering', 'Synchronous Lateral Excitation', 'TMD Dampers'],
      uncertaintyNotes: ['Initial reports blamed wind vortex shedding before full dynamic sensor instrumentation.'],
      researchedAt: new Date().toISOString(),
      sources: [
        {
          id: source1Id,
          url: 'https://www.nature.com/articles/35041703',
          title: 'Crowd synchrony on the Millennium Bridge',
          publisher: 'Nature Publishing Group',
          publishDate: '2005-11-03',
          credibilityTier: 'PEER_REVIEWED',
          retrievedAt: new Date().toISOString(),
        },
        {
          id: source2Id,
          url: 'https://www.arup.com/projects/millennium-bridge',
          title: 'Millennium Bridge Dynamic Stabilization Case Study',
          publisher: 'Arup Group',
          publishDate: '2001-05-15',
          credibilityTier: 'PRIMARY_SOURCE',
          retrievedAt: new Date().toISOString(),
        },
      ],
      claims: [
        {
          id: claim1Id,
          text: 'The Millennium Bridge opened in London in June 2000 and was closed after just two days due to excessive swaying.',
          entity: 'London Millennium Bridge',
          sourceId: source2Id,
          sourceCitation: 'Arup Technical Case Study (2001), Section 1',
          confidence: 0.99,
          isKeyFact: true,
          verified: true,
        },
        {
          id: claim2Id,
          text: 'The swaying was caused by synchronous lateral excitation: pedestrians naturally matched their footsteps to the sway frequency.',
          entity: 'Synchronous Lateral Excitation',
          sourceId: source1Id,
          sourceCitation: 'Nature 438, 43–44 (2005)',
          confidence: 0.98,
          isKeyFact: true,
          verified: true,
        },
        {
          id: claim3Id,
          text: 'Engineers installed 91 fluid viscous dampers and tuned mass dampers costing $8.9M to fix the bridge permanently.',
          entity: 'Arup Engineering',
          sourceId: source2Id,
          sourceCitation: 'Arup Technical Case Study (2001), Section 4',
          confidence: 0.95,
          isKeyFact: true,
          verified: true,
        },
      ],
    };
  }

  async developStory(topic: TopicCandidate, _research: ResearchPacket): Promise<StoryOutline> {
    return {
      id: randomUUID(),
      topicId: topic.id,
      logline: 'How London built a $25M futuristic bridge that opened on Monday—and had to be shut down on Wednesday because walking on it made everyone unconsciously break it.',
      centralConflict: 'Modern suspension design met unintended collective human biology.',
      hookConcept: 'The bridge designed so well that human footsteps broke it.',
      targetDurationSeconds: 45,
      narrativeArc: {
        hook: 'In 2000, London spent $25 million building this futuristic bridge. Within 48 hours, they had to shut it down.',
        context: 'Engineers tested it against hurricane-force winds and massive loads. Nothing was broken.',
        development: 'Yet as soon as thousands stepped on it, the deck swung side to side like a boat in rough seas.',
        twist: 'The flaw wasn’t the steel or the cables. It was human psychology: when people felt a micro-wobble, they widened their stance and stepped in unison, amplifying the frequency 100 times.',
        payoff: 'It took 91 giant shock absorbers hidden under the deck to silence the wobble forever.',
      },
      createdAt: new Date().toISOString(),
    };
  }

  async writeScript(story: StoryOutline, research: ResearchPacket): Promise<ShortScript> {
    const [c1, c2, c3] = research.claims;
    const scriptId = randomUUID();

    return {
      id: scriptId,
      storyId: story.id,
      topicId: story.topicId,
      title: 'Why London’s $25M Bridge Swayed Like a Boat',
      hookText: 'In 2000, London opened a $25 million bridge. Two days later, they had to shut it down.',
      targetDurationSeconds: 45,
      totalWords: 115,
      estimatedDurationSeconds: 45,
      createdAt: new Date().toISOString(),
      scenes: [
        {
          sceneNumber: 1,
          startTime: 0,
          endTime: 8,
          durationSeconds: 8,
          narration: 'In June 2000, London opened this futuristic twenty-five million dollar bridge. Forty-eight hours later, it was shut down.',
          visualObjective: 'Show wide majestic shot of London Millennium Bridge crossing the Thames with crowds.',
          mediaFormat: 'LICENSED_STOCK',
          assetKeywords: ['london', 'millennium bridge', 'thames', 'suspension bridge'],
          visualPrompt: 'Cinematic wide shot of London Millennium bridge over Thames river, dramatic sky, documentary tone',
          textOverlay: 'OPENED: JUNE 2000\nCLOSED: 48 HOURS LATER',
          transitionIntent: 'CUT',
          claimIds: [c1.id],
        },
        {
          sceneNumber: 2,
          startTime: 8,
          endTime: 20,
          durationSeconds: 12,
          narration: 'Engineers had tested for high winds and heavy loads. But the moment thousands of pedestrians walked across, the deck began violently swaying sideways.',
          visualObjective: 'Show vintage archive footage or diagram of bridge swinging laterally with pedestrians losing balance.',
          mediaFormat: 'HISTORICAL_IMAGE',
          assetKeywords: ['bridge sway', 'pedestrians walking', 'resonance test'],
          visualPrompt: 'Historical documentary photo of pedestrians holding rails of swaying bridge in London',
          textOverlay: 'LATERAL RESONANCE',
          transitionIntent: 'CUT',
          claimIds: [c1.id],
        },
        {
          sceneNumber: 3,
          startTime: 20,
          endTime: 33,
          durationSeconds: 13,
          narration: 'The flaw wasn’t the steel. It was human reflex: when people felt the slightest tilt, they unconsciously adjusted their stride to steady themselves—stepping in perfect sync.',
          visualObjective: 'Show dynamic animated diagram of synchronized pedestrian footfalls amplifying horizontal wave motion.',
          mediaFormat: 'CHART_DATA',
          assetKeywords: ['physics wave diagram', 'footstep sync', 'resonance curve'],
          visualPrompt: 'Scientific chart showing synchronized lateral excitation frequency curves and footstep vectors',
          textOverlay: 'SYNCHRONOUS LATERAL EXCITATION',
          transitionIntent: 'CUT',
          claimIds: [c2.id],
        },
        {
          sceneNumber: 4,
          startTime: 33,
          endTime: 45,
          durationSeconds: 12,
          narration: 'It took eighty-nine hydraulic dampers hidden beneath the deck to absorb the energy. A reminder that sometimes, the hardest engineering problem is human nature.',
          visualObjective: 'Show close-up technical shot of fluid viscous dampers beneath the bridge structure.',
          mediaFormat: 'LICENSED_STOCK',
          assetKeywords: ['hydraulic damper', 'shock absorber', 'structural engineering'],
          visualPrompt: 'Engineering macro shot of large industrial fluid viscous damper on steel suspension structure',
          textOverlay: 'THE FIX: 91 DAMPERS',
          transitionIntent: 'FADE',
          claimIds: [c3.id],
        },
      ],
    };
  }
}
