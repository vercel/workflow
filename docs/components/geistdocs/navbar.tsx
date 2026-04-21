import { basePath, Logo, nav, suggestions } from '@/geistdocs';
import { Chat } from './chat';
import { DesktopMenu } from './desktop-menu';
import { MobileMenu } from './mobile-menu';
import { NavbarLogo } from './navbar-logo';
import { SearchButton } from './search';

export const Navbar = () => (
  <header className="sticky top-0 z-40 flex h-16 justify-center border-b bg-background-200">
    <div className="mx-auto flex w-full max-w-[1448px] justify-between px-2">
      <div className="flex select-none flex-row items-center">
        <NavbarLogo className="ml-4" logo={<Logo />} variant="oss" />
        <DesktopMenu className="hidden pl-6 lg:flex" items={nav} />
      </div>
      <div className="mr-4 flex flex-row items-center justify-end gap-2">
        <SearchButton className="hidden lg:flex" />
        <Chat basePath={basePath} suggestions={suggestions} />
        <MobileMenu />
      </div>
    </div>
  </header>
);
