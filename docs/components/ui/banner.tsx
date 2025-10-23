export function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full fixed top-14 bg-primary text-blue-400 border-y border-fd-primary-foreground/30 px-4 py-2 [&_p]:m-0 flex items-start gap-2 z-40 text-sm [&_a]:underline [&_a]:text-foreground [&_a]:underline-offset-4 [&_a]:decoration-primary/35 [&_a]:hover:text-blue-400 [&_a]:font-medium ease-out">
      <div className="inline-flex [&_svg]:size-4 items-center gap-1.5 mx-auto">
        {children}
      </div>
    </div>
  );
}
