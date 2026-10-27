import {
  Activity,
  CircleDot,
  Crosshair,
  Footprints,
  Focus,
  ShieldHalf,
  Swords,
  Trophy,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Sport } from '@smartcoach/types';

export type CatalogSportId = Sport;
interface DisciplineContent {
  title: string;
  description: string;
  icon: LucideIcon;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  category: 'Court & field' | 'Combat' | 'Movement';
  focus: string;
  overview: string;
  movements: string[];
  sessionNote: string;
}
export type SportDiscipline = DisciplineContent & {
  id: Sport;
  availability: 'available' | 'experimental';
};
export type AvailableSportDiscipline = SportDiscipline;

// Squash uses the shared ApexFormz Brain and its versioned movement catalog.
export const SPORTS: SportDiscipline[] = [
  {
    id: 'squash',
    title: 'Squash',
    availability: 'available',
    description:
      'Explore the complete movement catalog with on-device recognition, phase tracking, and evidence-aware feedback.',
    icon: CircleDot,
    difficulty: 'Intermediate',
    category: 'Court & field',
    focus: 'Positions · Strokes · Footwork · Recovery',
    overview:
      'Choose from 184 catalog movements, organized by family and group. The Brain follows static positions and dynamic movements, recognizes supported techniques, tracks movement phases, and explains what the camera can assess.',
    movements: [
      'Static positions and racket preparation',
      'Drives, drops, boasts, and volleys',
      'Lunges, court movement, and T recovery',
    ],
    sessionNote:
      'Recognition currently covers 68 static and 109 dynamic classes. Technique rubrics remain provisional: strict mode withholds scores and coaching corrections until the required evidence and validation are available.',
  },
  {
    id: 'taekwondo',
    title: 'Taekwondo',
    availability: 'available',
    description:
      'Train controlled kicks, stable stances, and accurate technique.',
    icon: Swords,
    difficulty: 'Advanced',
    category: 'Combat',
    focus: 'Kicks · Balance · Technique',
    overview:
      'Choose a specific kick and give each part of the movement your attention. The library includes front, roundhouse, side, and back kicks, alongside jumping and sliding variations.',
    movements: [
      'Ap Chagi · Front kick',
      'Dollyo Chagi · Roundhouse kick',
      'Yeop Chagi · Side kick',
    ],
    sessionNote:
      'Select one movement before entering the studio. Camera framing and a clear view of your whole body help the coach follow the technique you chose.',
  },
  {
    id: 'yoga',
    title: 'Yoga',
    availability: 'available',
    description:
      'Develop stable poses with feedback on joint and body alignment.',
    icon: Focus,
    difficulty: 'Beginner',
    category: 'Movement',
    focus: 'Alignment · Stability · Form',
    overview:
      'Bring attention to one pose at a time. Explore standing and floor-based positions, with a selected reference to guide your alignment practice.',
    movements: ['Warrior II', 'Tree pose', 'Downward dog'],
    sessionNote:
      'The movement library also includes plank, bridge, chair, and a squat exercise. Choose the movement you want to practice before enabling your camera.',
  },
  {
    id: 'cricket',
    title: 'Cricket',
    availability: 'available',
    description:
      'Refine your batting stance, bowling action, and fielding position.',
    icon: Activity,
    difficulty: 'Intermediate',
    category: 'Court & field',
    focus: 'Stance · Alignment · Control',
    overview:
      'Focus your session on a batting, bowling, or fielding position. The library brings several parts of the game into one place, from a batting stance to a bowling load-up and fielding readiness.',
    movements: ['Batting stance', 'Bowling load-up', 'Cover drive'],
    sessionNote:
      'Movement selection determines what the coach looks for. You can return to the library to choose a different technique for your next session.',
  },
  {
    id: 'tennis',
    title: 'Tennis',
    availability: 'available',
    description:
      'Explore serve preparation, ready positions, and stroke alignment.',
    icon: Crosshair,
    difficulty: 'Advanced',
    category: 'Court & field',
    focus: 'Serve · Balance · Extension',
    overview:
      'Give a specific position or stroke your full attention. Practice starts with a selected technique, including the serve trophy, forehand top, ready position, and volley preparation.',
    movements: ['Serve trophy', 'Forehand top', 'Volley ready'],
    sessionNote:
      'The camera follows body landmarks. This experience focuses on movement and position; it does not measure ball speed, placement, or match results.',
  },
  {
    id: 'running',
    title: 'Running',
    availability: 'available',
    description: 'Work on stride mechanics, arm position, and running posture.',
    icon: Footprints,
    difficulty: 'Beginner',
    category: 'Movement',
    focus: 'Stride · Posture · Control',
    overview:
      'Take a closer look at the positions within your running technique. Select a focus such as mid-stride, starting position, knee drive, arm swing, or upright posture.',
    movements: ['Mid-stride', 'High knee drive', 'Arm swing path'],
    sessionNote:
      'Use the movement library to focus on technique. This is a camera-based practice space, rather than a GPS run, distance, or pace tracker.',
  },
  {
    id: 'boxing',
    title: 'Boxing',
    availability: 'available',
    description: 'Sharpen your guard, punch positioning, and defensive stance.',
    icon: ShieldHalf,
    difficulty: 'Advanced',
    category: 'Combat',
    focus: 'Guard · Stance · Precision',
    overview:
      'Choose a guard, punch, or defensive movement and work on its positioning. The library includes lead and rear-hand techniques, slips, and a foot-pivot focus.',
    movements: ['Guard stance', 'Lead jab', 'Right cross'],
    sessionNote:
      'Each session follows the technique selected in the library. Start with the movement you want feedback on, then review the saved session when you finish.',
  },
];

export const AVAILABLE_SPORTS = SPORTS;

// Keep existing athletes and historical records readable without returning
// retired discovery entries to the public catalog or sign-up choices.
export const LEGACY_SPORTS: { id: Sport; title: string; icon: LucideIcon }[] = [
  { id: 'football', title: 'Football', icon: Trophy },
];

export const SPORT_CATEGORIES = [
  'All sports',
  'Court & field',
  'Combat',
  'Movement',
] as const;
