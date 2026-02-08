"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Crown, Filter, X } from "lucide-react";

interface PlaylistFiltersProps {
  isPremium: boolean;
  channels: string[];
  onFilterChange: (filters: FilterState) => void;
}

export interface FilterState {
  minDuration: number | null; // seconds
  maxDuration: number | null; // seconds
  channel: string | null;
}

export function PlaylistFilters({
  isPremium,
  channels,
  onFilterChange,
}: PlaylistFiltersProps) {
  const [filters, setFilters] = useState<FilterState>({
    minDuration: null,
    maxDuration: null,
    channel: null,
  });

  const updateFilter = (key: keyof FilterState, value: number | string | null) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    onFilterChange(newFilters);
  };

  const clearFilters = () => {
    const cleared: FilterState = {
      minDuration: null,
      maxDuration: null,
      channel: null,
    };
    setFilters(cleared);
    onFilterChange(cleared);
  };

  const hasActiveFilters =
    filters.minDuration !== null ||
    filters.maxDuration !== null ||
    filters.channel !== null;

  if (!isPremium) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center">
        <Filter className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">Custom Filters</p>
        <Badge variant="outline" className="mt-1">
          <Crown className="mr-1 h-3 w-3" />
          Premium
        </Badge>
      </div>
    );
  }

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="filters" className="border-none">
        <AccordionTrigger className="py-2 text-sm font-medium">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
            {hasActiveFilters && (
              <Badge variant="secondary" className="text-xs">
                Active
              </Badge>
            )}
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-4 pt-2">
            {/* Duration Filter */}
            <div className="space-y-2">
              <Label className="text-xs">Duration (seconds)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  placeholder="Min"
                  value={filters.minDuration ?? ""}
                  onChange={(e) =>
                    updateFilter(
                      "minDuration",
                      e.target.value ? parseInt(e.target.value) : null
                    )
                  }
                  className="h-8"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={filters.maxDuration ?? ""}
                  onChange={(e) =>
                    updateFilter(
                      "maxDuration",
                      e.target.value ? parseInt(e.target.value) : null
                    )
                  }
                  className="h-8"
                />
              </div>
            </div>

            {/* Channel Filter */}
            <div className="space-y-2">
              <Label className="text-xs">Channel</Label>
              <Select
                value={filters.channel ?? "all"}
                onValueChange={(value) =>
                  updateFilter("channel", value === "all" ? null : value)
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="All channels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channels.map((channel) => (
                    <SelectItem key={channel} value={channel}>
                      {channel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="w-full"
              >
                <X className="mr-2 h-3 w-3" />
                Clear all filters
              </Button>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
