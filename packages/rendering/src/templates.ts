import { VideoTemplateType } from '@shorts/schemas';

export interface VideoTemplateConfig {
  id: VideoTemplateType;
  name: string;
  description: string;
  backgroundColor: string;
  accentColor: string;
  textColor: string;
  fontFamily: string;
  defaultTransition: 'CUT' | 'FADE' | 'ZOOM_IN';
}

export const TEMPLATES: Record<VideoTemplateType, VideoTemplateConfig> = {
  DOCUMENTARY: {
    id: 'DOCUMENTARY',
    name: 'Documentary Classic',
    description: 'Cinematic deep slate and gold accents, high contrast typography, dramatic pacing.',
    backgroundColor: '#0f172a',
    accentColor: '#eab308',
    textColor: '#f8fafc',
    fontFamily: 'Arial',
    defaultTransition: 'CUT',
  },
  DATA_CHART: {
    id: 'DATA_CHART',
    name: 'Data & Infographic',
    description: 'Technical gridlines, dynamic statistics, clean cyan data markers.',
    backgroundColor: '#030712',
    accentColor: '#06b6d4',
    textColor: '#f9fafb',
    fontFamily: 'Arial',
    defaultTransition: 'CUT',
  },
  TIMELINE: {
    id: 'TIMELINE',
    name: 'Historical Timeline',
    description: 'Chronological progression markers, warm sepia tones, date callouts.',
    backgroundColor: '#1c1917',
    accentColor: '#f97316',
    textColor: '#fafaf9',
    fontFamily: 'Arial',
    defaultTransition: 'FADE',
  },
  MAP_GEOGRAPHIC: {
    id: 'MAP_GEOGRAPHIC',
    name: 'Geographic Exploration',
    description: 'Satellite view framing, topographic contour lines, emerald location pings.',
    backgroundColor: '#064e3b',
    accentColor: '#10b981',
    textColor: '#ffffff',
    fontFamily: 'Arial',
    defaultTransition: 'ZOOM_IN',
  },
  TECHNOLOGY_PRODUCT: {
    id: 'TECHNOLOGY_PRODUCT',
    name: 'Product & Tech Breakdown',
    description: 'Modern blueprint aesthetics, violet highlights, schematic callouts.',
    backgroundColor: '#09090b',
    accentColor: '#8b5cf6',
    textColor: '#ffffff',
    fontFamily: 'Arial',
    defaultTransition: 'CUT',
  },
};
