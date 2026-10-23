import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </IconBase>
  );
}

export function OrdersIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 4.5h6" />
      <path d="M9 3h6a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 15 7H9a1.5 1.5 0 0 1-1.5-1.5v-1A1.5 1.5 0 0 1 9 3Z" />
      <path d="M7 5H5.5A1.5 1.5 0 0 0 4 6.5v13A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 18.5 5H17" />
      <path d="M8 11h8M8 15h8M8 19h5" />
    </IconBase>
  );
}

export function DespieceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m4 12 8 4.3 8-4.3" />
      <path d="m4 16.5 8 4.3 8-4.3" />
    </IconBase>
  );
}

export function MaterialsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
      <path d="m8 5.2 8 4.5" />
    </IconBase>
  );
}

export function OperatorsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17 15a5.5 5.5 0 0 1 3.5 5" />
    </IconBase>
  );
}

export function SectorsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="6" height="5" rx="1.3" />
      <rect x="15" y="3" width="6" height="5" rx="1.3" />
      <rect x="9" y="16" width="6" height="5" rx="1.3" />
      <path d="M6 8v3.5a2 2 0 0 0 2 2h1M18 8v3.5a2 2 0 0 1-2 2h-1M12 13.5V16" />
    </IconBase>
  );
}

export function QualityIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 4.5 6v5.5c0 4.6 3 7.7 7.5 9.5 4.5-1.8 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.5 11.8 2.3 2.3 4.7-5" />
    </IconBase>
  );
}

export function MaintenanceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.7 6.3a4.2 4.2 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4.2 4.2 0 0 0 5.4-5.4l-2.6 2.6-3-3 2.6-2.6Z" />
    </IconBase>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </IconBase>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 5 7 7-7 7" />
    </IconBase>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 17 17 7M8 7h9v9" />
    </IconBase>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.5 21 20H3L12 3.5Z" />
      <path d="M12 9v5M12 17.2v.1" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </IconBase>
  );
}

export function LoginIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M10 8l4 4-4 4M14 12H3" />
    </IconBase>
  );
}

export function BrandMark(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7.5 9.5 12 4 16.5M10 7.5 15.5 12 10 16.5" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </IconBase>
  );
}
