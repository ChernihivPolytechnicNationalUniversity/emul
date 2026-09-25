import type * as React from "react"

export type Icon = React.ComponentType<React.SVGProps<SVGSVGElement>>

export const make = (name: string, children: React.ReactNode): Icon => {
  const C = (props: React.SVGProps<SVGSVGElement>) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  )
  C.displayName = name
  return C
}
