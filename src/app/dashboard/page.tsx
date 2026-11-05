import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <DashboardClient appOrigin={process.env.APP_ORIGIN ?? ""} />;
}
