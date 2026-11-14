import PlannerApp from "@/components/PlannerApp";
import { addDaysISO, todayISOLocal } from "@/lib/geo";
import { isAmapConfigured } from "@/lib/providers";

export default function HomePage() {
  const initialDate = addDaysISO(todayISOLocal(), 1);
  return <PlannerApp initialDate={initialDate} liveData={isAmapConfigured()} />;
}
