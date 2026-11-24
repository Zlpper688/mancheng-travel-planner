export interface MetroStation {
  name: string;
  lat: number;
  lng: number;
  lines: string[];
}

export interface MetroAccess {
  station: MetroStation;
  walkKm: number;
  walkMin: number;
}

export interface MetroTrip {
  minutes: number;
  rideMin: number;
  walkMin: number;
  walkKm: number;
  waitMin: number;
  rideKm: number;
  lines: string[];
  fromStation: string;
  toStation: string;
  transfers: number;
  stations: { name: string; lat: number; lng: number }[];
}