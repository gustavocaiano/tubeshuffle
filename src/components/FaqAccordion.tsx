"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface FaqItem {
  question: string;
  answer: string;
}

export function FaqAccordion({ faqs }: { faqs: FaqItem[] }) {
  return (
    <Accordion type="single" collapsible className="w-full">
      {faqs.map((faq, index) => (
        <AccordionItem key={index} value={`faq-${index}`}>
          <AccordionTrigger className="text-left text-base">
            {faq.question}
          </AccordionTrigger>
          <AccordionContent className="text-white/55">
            {faq.answer}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
