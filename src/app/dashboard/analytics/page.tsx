"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Navbar } from "@/components/layouts/Navbar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  BarChart3,
  Play,
  CheckCircle2,
  Crown,
  Music,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";

export default function AnalyticsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const profileQuery = trpc.user.getProfile.useQuery(undefined, {
    enabled: !!session,
  });

  const analyticsQuery = trpc.user.getAnalytics.useQuery(undefined, {
    enabled: !!session,
  });

  if (status === "loading" || status === "unauthenticated") {
    return null;
  }

  const isPremium = profileQuery.data?.subscription === "PREMIUM";
  const analytics = analyticsQuery.data;

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1">
        <div className="container mx-auto px-4 py-8">
          <div className="mb-6 flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Listening Analytics</h1>
              <p className="text-sm text-muted-foreground">
                Track your listening habits and discover patterns
              </p>
            </div>
          </div>

          {!isPremium ? (
            <Card className="mx-auto max-w-md text-center">
              <CardContent className="py-12">
                <Crown className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
                <CardTitle>Premium Feature</CardTitle>
                <CardDescription className="mt-2">
                  Analytics are available for Premium subscribers.
                </CardDescription>
                <Link href="/pricing">
                  <Button className="mt-6">
                    <Crown className="mr-2 h-4 w-4" />
                    Upgrade to Premium
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : analyticsQuery.isLoading ? (
            <div className="grid gap-6 md:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-6">
                    <Skeleton className="h-8 w-20" />
                    <Skeleton className="mt-2 h-4 w-32" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : analytics ? (
            <div className="space-y-8">
              {/* Stats Cards */}
              <div className="grid gap-6 md:grid-cols-3">
                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Play className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">
                          {analytics.totalPlays}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Total plays
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">
                          {analytics.completedPlays}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Completed
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                        <BarChart3 className="h-5 w-5 text-blue-500" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold">
                          {analytics.completionRate}%
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Completion rate
                        </p>
                      </div>
                    </div>
                    <Progress
                      value={analytics.completionRate}
                      className="mt-3"
                    />
                  </CardContent>
                </Card>
              </div>

              {/* Most Played */}
              <Card>
                <CardHeader>
                  <CardTitle>Most Played Videos</CardTitle>
                  <CardDescription>
                    Your top 10 most frequently played videos
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {analytics.mostPlayed.length === 0 ? (
                    <div className="flex flex-col items-center py-8 text-center">
                      <Music className="mb-2 h-8 w-8 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        No play history yet. Start listening to build your stats!
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {analytics.mostPlayed.map((item, index) => (
                        <div
                          key={item.video?.id ?? index}
                          className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent"
                        >
                          <span className="w-6 text-center text-sm font-medium text-muted-foreground">
                            {index + 1}
                          </span>
                          <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
                            {item.video?.thumbnail ? (
                              <Image
                                src={item.video.thumbnail}
                                alt={item.video.title}
                                fill
                                className="object-cover"
                                sizes="64px"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center">
                                <Music className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {item.video?.title ?? "Unknown video"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.video?.channelTitle ?? "Unknown channel"}
                            </p>
                          </div>
                          <span className="text-sm font-medium">
                            {item.playCount} plays
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
