"use client";

import {
  AlertTriangle,
  Baby,
  BedDouble,
  Binoculars,
  BookOpen,
  Building2,
  Bus,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Church,
  Clock3,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Coffee,
  Compass,
  Footprints,
  Home,
  Info,
  Landmark,
  Lock,
  LockOpen,
  MapPin,
  Mountain,
  RefreshCw,
  Route,
  Search,
  Ship,
  Shuffle,
  Sparkles,
  Star,
  Store,
  TrainFront,
  Sun,
  Sunrise,
  Sunset,
  Moon,
  Ticket,
  Trees,
  Users,
  Utensils,
  Wallet,
  Waves,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  footprints: Footprints,
  landmark: Landmark,
  waves: Waves,
  "book-open": BookOpen,
  utensils: Utensils,
  baby: Baby,
  sparkles: Sparkles,
  star: Star,
  bus: Bus,
  train: TrainFront,
  ship: Ship,
  car: Car,
  building: Building2,
  trees: Trees,
  binoculars: Binoculars,
  route: Route,
  church: Church,
  store: Store,
  mountain: Mountain,
  coffee: Coffee,
  home: Home,
  "map-pin": MapPin,
  compass: Compass,
  bed: BedDouble,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  shuffle: Shuffle,
  clock: Clock3,
  wallet: Wallet,
  info: Info,
  alert: AlertTriangle,
  refresh: RefreshCw,
  search: Search,
  ticket: Ticket,
  calendar: CalendarDays,
  users: Users,
  check: Check,
  x: X,
  lock: Lock,
  unlock: LockOpen,
  sun: Sun,
  sunrise: Sunrise,
  sunset: Sunset,
  moon: Moon,
  "cloud-sun": CloudSun,
  cloud: Cloud,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
  fog: CloudFog,
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.8,
}: {
  name: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const Component = ICONS[name] ?? MapPin;
  return (
    <Component
      size={size}
      className={className}
      strokeWidth={strokeWidth}
      aria-hidden="true"
    />
  );
}
