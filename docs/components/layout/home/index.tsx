'use client';

import { NavProvider } from 'fumadocs-ui/contexts/layout';
import { useSidebar } from 'fumadocs-ui/contexts/sidebar';
import {
  ChevronDown,
  Languages,
  Menu as MenuIcon,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, type HTMLAttributes, useMemo } from 'react';
import { Banner } from '@/components/banner';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import { LanguageToggle, LanguageToggleText } from '../../language-toggle';
import { LargeSearchToggle, SearchToggle } from '../../search-toggle';
import { ThemeToggle } from '../../theme-toggle';
import { Button, buttonVariants } from '../../ui/button';
import {
  type BaseLayoutProps,
  getLinks,
  type LinkItemType,
  type NavOptions,
} from '../shared/index';
import { Menu, MenuContent, MenuLinkItem, MenuTrigger } from './menu';
import {
  Navbar,
  NavbarLink,
  NavbarMenu,
  NavbarMenuContent,
  NavbarMenuLink,
  NavbarMenuTrigger,
} from './navbar';

export interface HomeLayoutProps extends BaseLayoutProps {
  baseOptions: () => {
    nav?: Partial<
      NavOptions & {
        /**
         * Open mobile menu when hovering the trigger
         */
        enableHoverToOpen?: boolean;
      }
    >;
  };
}

export function HomeLayout(
  props: HomeLayoutProps & HTMLAttributes<HTMLElement>
) {
  const combinedProps = Object.assign({}, props.baseOptions?.(), props);
  const {
    nav = {},
    links,
    githubUrl,
    i18n,
    themeSwitch = { enabled: true },
    searchToggle,
    baseOptions: _baseOptions,
    ...rest
  } = combinedProps;

  return (
    <NavProvider transparentMode={nav?.transparentMode}>
      <main
        id="nd-home-layout"
        {...rest}
        className={cn('flex flex-1 flex-col', rest.className)}
      >
        {nav.enabled !== false &&
          (nav.component ?? (
            <Header
              githubUrl={githubUrl}
              i18n={i18n}
              links={links}
              nav={nav}
              searchToggle={searchToggle}
              themeSwitch={themeSwitch}
            />
          ))}
        {props.children}
        <footer className="px-4 mx-auto sm:mt-[90px] flex w-full max-w-[1080px] items-center justify-between gap-8 py-12 sm:py-[90px]">
          <Link href="https://vercel.com">
            <svg
              fill="none"
              height="20"
              viewBox="0 0 2048 407"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                clipRule="evenodd"
                d="M467.444 406.664L233.722 0.190918L0 406.664H467.444ZM703.186 388.161L898.51 18.668H814.024L679.286 287.007L544.547 18.668H460.061L655.385 388.161H703.186ZM2034.31 18.668V388.162H1964.37V18.668H2034.31ZM1644.98 250.25C1644.98 221.454 1650.99 196.127 1663.01 174.27C1675.03 152.412 1691.79 135.586 1713.28 123.79C1734.77 111.994 1759.91 106.095 1788.69 106.095C1814.19 106.095 1837.14 111.647 1857.54 122.749C1877.94 133.851 1894.15 150.331 1906.17 172.188C1918.19 194.046 1924.39 220.76 1924.75 252.332V268.465H1718.75C1720.2 291.363 1726.94 309.404 1738.96 322.588C1751.35 335.425 1767.93 341.843 1788.69 341.843C1801.8 341.843 1813.83 338.374 1824.75 331.435C1835.68 324.496 1843.88 315.129 1849.34 303.333L1920.93 308.537C1912.18 334.557 1895.79 355.374 1871.75 370.986C1847.7 386.599 1820.02 394.405 1788.69 394.405C1759.91 394.405 1734.77 388.507 1713.28 376.711C1691.79 364.915 1675.03 348.088 1663.01 326.231C1650.99 304.373 1644.98 279.047 1644.98 250.25ZM1852.62 224.23C1850.07 201.678 1842.97 185.199 1831.31 174.79C1819.65 164.035 1805.45 158.657 1788.69 158.657C1769.38 158.657 1753.72 164.382 1741.7 175.831C1729.67 187.28 1722.21 203.413 1719.29 224.23H1852.62ZM1526.96 174.79C1538.62 184.158 1545.9 197.168 1548.82 213.821L1620.94 210.178C1618.39 189.015 1610.93 170.627 1598.54 155.014C1586.15 139.402 1570.13 127.433 1550.45 119.106C1531.15 110.432 1509.84 106.095 1486.52 106.095C1457.74 106.095 1432.61 111.994 1411.11 123.79C1389.62 135.586 1372.86 152.412 1360.84 174.27C1348.82 196.127 1342.81 221.454 1342.81 250.25C1342.81 279.047 1348.82 304.373 1360.84 326.231C1372.86 348.088 1389.62 364.915 1411.11 376.711C1432.61 388.507 1457.74 394.405 1486.52 394.405C1510.56 394.405 1532.42 390.068 1552.09 381.395C1571.77 372.374 1587.79 359.711 1600.18 343.404C1612.57 327.098 1620.03 308.016 1622.58 286.159L1549.91 283.036C1547.36 301.424 1540.25 315.649 1528.6 325.71C1516.94 335.425 1502.91 340.282 1486.52 340.282C1463.94 340.282 1446.45 332.476 1434.06 316.863C1421.68 301.251 1415.49 279.047 1415.49 250.25C1415.49 221.454 1421.68 199.25 1434.06 183.637C1446.45 168.025 1463.94 160.219 1486.52 160.219C1502.19 160.219 1515.66 165.076 1526.96 174.79ZM1172.15 112.328H1237.24L1239.12 165.414C1243.74 150.388 1250.16 138.719 1258.39 130.407C1270.32 118.355 1286.96 112.328 1308.29 112.328H1334.87V169.148H1307.75C1292.56 169.148 1280.09 171.214 1270.32 175.346C1260.92 179.478 1253.69 186.021 1248.63 194.975C1243.93 203.928 1241.58 215.292 1241.58 229.066V388.161H1172.15V112.328ZM871.925 174.27C859.904 196.127 853.893 221.454 853.893 250.25C853.893 279.047 859.904 304.373 871.925 326.231C883.947 348.088 900.704 364.915 922.198 376.711C943.691 388.507 968.827 394.405 997.606 394.405C1028.93 394.405 1056.62 386.599 1080.66 370.986C1104.71 355.374 1121.1 334.557 1129.84 308.537L1058.26 303.333C1052.8 315.129 1044.6 324.496 1033.67 331.435C1022.74 338.374 1010.72 341.843 997.606 341.843C976.841 341.843 960.266 335.425 947.88 322.588C935.858 309.404 929.119 291.363 927.662 268.465H1133.67V252.332C1133.3 220.76 1127.11 194.046 1115.09 172.188C1103.07 150.331 1086.86 133.851 1066.46 122.749C1046.06 111.647 1023.11 106.095 997.606 106.095C968.827 106.095 943.691 111.994 922.198 123.79C900.704 135.586 883.947 152.412 871.925 174.27ZM1040.23 174.79C1051.88 185.199 1058.99 201.678 1061.54 224.23H928.208C931.123 203.413 938.591 187.28 950.612 175.831C962.634 164.382 978.298 158.657 997.606 158.657C1014.36 158.657 1028.57 164.035 1040.23 174.79Z"
                fill="currentColor"
                fillRule="evenodd"
              />
            </svg>
          </Link>
          {themeSwitch.enabled !== false &&
            (themeSwitch.component ?? <ThemeToggle mode={themeSwitch?.mode} />)}
        </footer>
      </main>
    </NavProvider>
  );
}

function SidebarToggle() {
  const pathname = usePathname();
  const { open, setOpen } = useSidebar();

  // only show on docs pages
  if (!pathname?.startsWith('/docs')) return null;

  return (
    <button
      aria-label="Toggle Sidebar"
      className="inline-flex items-center justify-center rounded-md p-2 text-fd-muted-foreground transition-opacity hover:opacity-60 md:hidden"
      onClick={() => setOpen(!open)}
    >
      <MenuIcon className="size-5" />
    </button>
  );
}

export function Header({
  nav = {},
  i18n = false,
  links,
  githubUrl,
  themeSwitch = {},
  searchToggle = {},
}: HomeLayoutProps) {
  const finalLinks = useMemo(
    () => getLinks(links, githubUrl),
    [links, githubUrl]
  );

  const navItems = finalLinks.filter((item) =>
    ['nav', 'all'].includes(item.on ?? 'all')
  );
  const menuItems = finalLinks.filter((item) =>
    ['menu', 'all'].includes(item.on ?? 'all')
  );

  return (
    <Navbar>
      <div className="flex items-center gap-2.5">
        <SidebarToggle />
        <Link href="https://vercel.com">
          <svg
            className="fill-current"
            fill="none"
            height="18"
            viewBox="0 0 75 65"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Vercel</title>
            <path d="M37.59.25l36.95 64H.64l36.95-64z" fill="currentColor" />
          </svg>
        </Link>
        <div className="w-4 text-center text-lg text-muted-foreground/25">
          <svg
            data-testid="geist-icon"
            height="16"
            strokeLinejoin="round"
            viewBox="0 0 16 16"
            width="16"
          >
            <path
              clipRule="evenodd"
              d="M4.01526 15.3939L4.3107 14.7046L10.3107 0.704556L10.6061 0.0151978L11.9849 0.606077L11.6894 1.29544L5.68942 15.2954L5.39398 15.9848L4.01526 15.3939Z"
              fill="currentColor"
              fillRule="evenodd"
            />
          </svg>
        </div>
        <Link
          className="inline-flex items-center gap-2.5"
          href={nav.url ?? '/'}
        >
          {nav.title}
        </Link>
      </div>
      {nav.children}
      <ul className="flex flex-row items-center gap-2 px-6 max-sm:hidden">
        {navItems
          .filter((item) => !isSecondary(item))
          .map((item, i) => (
            <NavbarLinkItem className="text-sm" item={item} key={i} />
          ))}
      </ul>
      <div className="flex flex-1 flex-row items-center justify-end gap-2 max-lg:hidden">
        {searchToggle.enabled !== false &&
          (searchToggle.components?.lg ?? (
            <LargeSearchToggle
              className="w-full max-w-[172px] border-none bg-secondary ps-3"
              hideIfDisabled
            />
          ))}
        {i18n ? (
          <LanguageToggle>
            <Languages className="size-5" />
          </LanguageToggle>
        ) : null}
        <div className="flex flex-row items-center empty:hidden">
          {navItems.filter(isSecondary).map((item, i) => (
            <NavbarLinkItem item={item} key={i} />
          ))}
        </div>
        <Button asChild size="sm" variant="default">
          <Link href="https://github.com/vercel/workflow">
            <svg
              width="15"
              height="15"
              viewBox="0 0 15 15"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"
                fill="currentColor"
                fillRule="evenodd"
                clipRule="evenodd"
              ></path>
            </svg>
            GitHub
          </Link>
        </Button>
      </div>
      <ul className="ms-auto flex flex-row items-center gap-3 lg:hidden">
        <Link
          href="https://github.com/vercel/workflow"
          className={cn(
            buttonVariants({
              size: 'icon',
              variant: 'ghost',
            }),
            '!bg-transparent !p-2 text-fd-muted-foreground'
          )}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
            ></path>
          </svg>
        </Link>
        {searchToggle.enabled !== false &&
          (searchToggle.components?.sm ?? (
            <SearchToggle
              className="!bg-transparent !p-2 text-fd-muted-foreground"
              color="ghost"
              hideIfDisabled
              size="icon"
            />
          ))}
        <Menu>
          <MenuTrigger
            aria-label="Toggle Menu"
            className={cn(
              buttonVariants({
                size: 'icon',
                color: 'ghost',
              }),
              '!bg-transparent !p-2 group text-fd-muted-foreground sm:hidden'
            )}
            enableHover={nav.enableHoverToOpen}
          >
            <ChevronDown className="size-4 transition-transform duration-300 group-data-[state=open]:rotate-180" />
          </MenuTrigger>
          <MenuContent className="sm:flex-row sm:items-center sm:justify-end">
            {menuItems
              .filter((item) => !isSecondary(item))
              .map((item, i) => (
                <MenuLinkItem className="sm:hidden" item={item} key={i} />
              ))}
            <div className="-ms-1.5 flex flex-row items-center gap-1.5 max-sm:mt-2">
              {menuItems.filter(isSecondary).map((item, i) => (
                <MenuLinkItem className="-me-1.5" item={item} key={i} />
              ))}
              <div className="flex-1" role="separator" />
              {i18n ? (
                <LanguageToggle>
                  <Languages className="size-5" />
                  <LanguageToggleText />
                  <ChevronDown className="size-3 text-fd-muted-foreground" />
                </LanguageToggle>
              ) : null}
            </div>
          </MenuContent>
        </Menu>
      </ul>
    </Navbar>
  );
}

function NavbarLinkItem({
  item,
  ...props
}: {
  item: LinkItemType;
  className?: string;
}) {
  if (item.type === 'custom') return <div {...props}>{item.children}</div>;

  if (item.type === 'menu') {
    const children = item.items.map((child, j) => {
      if (child.type === 'custom')
        return <Fragment key={j}>{child.children}</Fragment>;

      const {
        banner = child.icon ? (
          <div className="w-fit rounded-md border bg-fd-muted p-1 [&_svg]:size-4">
            {child.icon}
          </div>
        ) : null,
        ...rest
      } = child.menu ?? {};

      return (
        <NavbarMenuLink href={child.url} key={j} {...rest}>
          {rest.children ?? (
            <>
              {banner}
              <p className="font-medium text-[15px]">{child.text}</p>
              <p className="text-fd-muted-foreground text-sm empty:hidden">
                {child.description}
              </p>
            </>
          )}
        </NavbarMenuLink>
      );
    });

    return (
      <NavbarMenu>
        <NavbarMenuTrigger {...props}>
          {item.url ? <Link href={item.url}>{item.text}</Link> : item.text}
        </NavbarMenuTrigger>
        <NavbarMenuContent>{children}</NavbarMenuContent>
      </NavbarMenu>
    );
  }

  return (
    <NavbarLink
      {...props}
      aria-label={item.type === 'icon' ? item.label : undefined}
      item={item}
      variant={item.type}
    >
      {item.type === 'icon' ? item.icon : item.text}
    </NavbarLink>
  );
}

function isSecondary(item: LinkItemType): boolean {
  if ('secondary' in item && item.secondary != null) return item.secondary;

  return item.type === 'icon';
}
