'use client';

import { track } from '@vercel/analytics';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type UseCase = {
  id: string;
  label: string;
  codeBlock: React.ReactNode;
};

export const UseCasesClient = ({ useCases }: { useCases: UseCase[] }) => {
  const [selectedCase, setSelectedCase] = useState(useCases[0].id);
  const currentCase =
    useCases.find((uc) => uc.id === selectedCase) || useCases[0];

  const handleCaseChange = (value: string) => {
    setSelectedCase(value);
    track('Use case changed', { case: value });
  };

  return (
    <div className="grid sm:grid-cols-3 sm:divide-x p-8 sm:p-0 gap-12 sm:gap-0">
      <div className="text-balance flex flex-col gap-2 sm:p-12">
        <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl">
          Build anything with
          <Select value={selectedCase} onValueChange={handleCaseChange}>
            <SelectTrigger className="font-semibold bg-background text-xl tracking-tight sm:text-2xl md:text-3xl mt-1.5 data-[size=default]:h-auto py-1.5 -ml-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {useCases.map((useCase) => (
                <SelectItem key={useCase.id} value={useCase.id}>
                  {useCase.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </h2>
        <p className="text-balance text-lg text-muted-foreground mt-2">
          Build reliable, long-running processes with automatic retries, state
          persistence, and observability built in.
        </p>
      </div>
      <div className="col-span-2 sm:p-12">{currentCase.codeBlock}</div>
    </div>
  );
};
