/** biome-ignore-all lint/a11y/noSvgWithoutTitle: complex viz with many sub-elements */
import type { SVGProps } from 'react';

export const O11yDashboard = ({
  svgId = 'o11y',
  ...props
}: SVGProps<SVGSVGElement> & { svgId?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 832 495"
      fill="none"
      aria-hidden
      {...props}
    >
      <title>o11y dashboard of Vercel</title>
      <g
        filter={`url(#a-${svgId})`}
        className="[&_[data-hoverable='fill']]:fill-transparent [&_[data-hoverable]]:pointer-events-auto [&_[data-hoverable]]:cursor-pointer [&_[data-hoverable='fill']:hover]:fill-gray-200 [&_*:not([data-hoverable])]:pointer-events-none [&_[data-hoverable='text']:hover]:underline"
      >
        <g clipPath={`url(#b-${svgId})`}>
          <path
            className="fill-background-100"
            d="M3 14.964C3 7.252 9.252 1 16.964 1h797.132c7.712 0 13.964 6.252 13.964 13.964v456.169c0 7.712-6.252 13.964-13.964 13.964H16.964C9.252 485.097 3 478.845 3 471.133V14.964Z"
            shapeRendering="crispEdges"
          />
          <circle
            cx={26.201}
            cy={24.201}
            r={5.746}
            className="fill-gray-alpha-200"
          />
          <circle
            cx={43.438}
            cy={24.201}
            r={5.746}
            className="fill-gray-alpha-200"
          />
          <circle
            cx={60.675}
            cy={24.201}
            r={5.746}
            className="fill-gray-alpha-200"
          />
          <g clipPath={`url(#c-${svgId})`}>
            <mask id={`P-${svgId}`} fill="#fff">
              <path d="M3.582 45.22h823.896V844.68H3.582V45.22Z" />
            </mask>
            <path
              className="fill-background-200"
              d="M3.582 45.22h823.896V844.68H3.582V45.22Z"
            />
            <mask id={`d-${svgId}`} fill="#fff">
              <path d="M3.582 45.22h212.956v705.2H3.582V45.22Z" />
            </mask>
            <path
              className="fill-gray-alpha-100"
              d="M216.538 45.22h-.832v440h1.665V45.22h-.833Z"
              mask={`url(#d-${svgId})`}
            />
            <g clipPath={`url(#e-${svgId})`}>
              <rect
                width={16.646}
                height={16.646}
                x={18.564}
                y={60.202}
                fill={`url(#f-${svgId})`}
                rx={8.323}
              />
              <rect
                width={15.814}
                height={15.814}
                x={18.98}
                y={60.618}
                className="stroke-gray-alpha-400"
                strokeWidth={0.832}
                rx={7.907}
              />
            </g>
            <text
              xmlSpace="preserve"
              className="fill-gray-1000"
              fontFamily="Geist"
              fontSize={11.652}
              fontWeight={500}
              letterSpacing="0em"
              style={{
                whiteSpace: 'pre',
              }}
            >
              <tspan x={43.533} y={72.427}>
                Acme
              </tspan>
            </text>
            <path
              className="fill-blue-200"
              d="M82.191 68.525a8.665 8.665 0 0 1 8.665-8.665h7.659a8.664 8.664 0 0 1 8.664 8.665 8.664 8.664 0 0 1-8.665 8.665h-7.658a8.665 8.665 0 0 1-8.665-8.665Z"
            />
            <text
              xmlSpace="preserve"
              className="fill-blue-700"
              fontFamily="Geist"
              fontSize={9.155}
              fontWeight={500}
              letterSpacing="0em"
              style={{
                whiteSpace: 'pre',
              }}
            >
              <tspan x={87.359} y={71.388}>
                Pro
              </tspan>
            </text>
            <path
              data-hoverable="fill"
              d="M183.245 60.202a4.994 4.994 0 0 1 4.994-4.994h9.988a4.994 4.994 0 0 1 4.994 4.994v16.646a4.994 4.994 0 0 1-4.994 4.994h-9.988a4.994 4.994 0 0 1-4.994-4.994V60.202Z"
            />
            <path
              className="fill-gray-900"
              d="m196.613 70.398-2.791 2.791a.832.832 0 0 1-1.177 0l-2.791-2.791.882-.883 2.497 2.497 2.497-2.497.883.883Zm-3.968-6.536a.833.833 0 0 1 1.114-.058l.063.058 2.791 2.79-.883.884-2.497-2.497-2.497 2.497-.882-.883 2.791-2.791Z"
            />
            <path
              className="fill-background-100"
              d="M10.24 96.824a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.304a4.993 4.993 0 0 1-4.993 4.994H15.234a4.993 4.993 0 0 1-4.994-4.994V96.824Z"
            />
            <path
              className="stroke-gray-alpha-400"
              strokeWidth={0.832}
              d="M204.886 91.414a5.41 5.41 0 0 1 5.41 5.41v23.305a5.411 5.411 0 0 1-5.41 5.41H15.234a5.41 5.41 0 0 1-5.41-5.41V96.824a5.41 5.41 0 0 1 5.41-5.41h189.652Z"
            />
            <g clipPath={`url(#g-${svgId})`}>
              <path
                className="fill-gray-700"
                d="M25.638 101.818a5.41 5.41 0 0 1 4.24 8.767l3.3 3.301-.882.883-3.3-3.301a5.411 5.411 0 1 1-3.357-9.65Zm0 1.248a4.162 4.162 0 1 0 0 8.322 4.162 4.162 0 0 0 0-8.322Z"
              />
            </g>
            <text
              xmlSpace="preserve"
              className="fill-gray-700"
              fontFamily="Geist"
              fontSize={11.652}
              letterSpacing="0em"
              style={{
                whiteSpace: 'pre',
              }}
            >
              <tspan x={43.532} y={112.378}>
                Find...
              </tspan>
            </text>
            <path
              className="fill-background-100"
              d="M185.568 105.147a4.994 4.994 0 0 1 4.994-4.994h6a4.994 4.994 0 0 1 4.994 4.994v6.658a4.994 4.994 0 0 1-4.994 4.994h-6a4.994 4.994 0 0 1-4.994-4.994v-6.658Z"
            />
            <path
              className="stroke-gray-alpha-400"
              strokeWidth={0.832}
              d="M196.562 99.737a5.41 5.41 0 0 1 5.411 5.41v6.658a5.41 5.41 0 0 1-5.411 5.41h-6a5.41 5.41 0 0 1-5.41-5.41v-6.658a5.41 5.41 0 0 1 5.41-5.41h6Z"
            />
            <text
              xmlSpace="preserve"
              className="fill-gray-900"
              fontFamily="Geist"
              fontSize={9.988}
              fontWeight={500}
              letterSpacing="0em"
              style={{
                whiteSpace: 'pre',
              }}
            >
              <tspan x={190.562} y={111.63}>
                F
              </tspan>
            </text>
            <g transform="translate(0, -166.46)">
              {/* Workflows (active) */}
              <path
                className="fill-gray-alpha-200"
                d="M10.24 303.237a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.305a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994v-23.305Z"
              />
              {/** biome-ignore lint/a11y/noSvgWithoutTitle: too detailed element of viz */}
              <svg
                x={20.5}
                y={307.8}
                width={13}
                height={13}
                viewBox="2 2 16 16"
              >
                <path
                  className="fill-gray-900"
                  d="M15.75 2C16.9926 2 18 3.00736 18 4.25V15.75C18 16.9926 16.9926 18 15.75 18H4.25C3.00736 18 2 16.9926 2 15.75V4.25C2 3.00736 3.00736 2 4.25 2H15.75ZM4.25 3.5C3.83579 3.5 3.5 3.83579 3.5 4.25V15.75C3.5 16.1642 3.83579 16.5 4.25 16.5H15.75C16.1642 16.5 16.5 16.1642 16.5 15.75V4.25C16.5 3.83579 16.1642 3.5 15.75 3.5H4.25ZM12.9971 7H12.2471C11.4208 7 10.751 7.66982 10.751 8.49609V9H12.5V10.5H10.751V11.5049C10.7507 13.1589 9.40892 14.4997 7.75488 14.5H7.00488V13H7.75488C8.5805 12.9997 9.25071 12.3305 9.25098 11.5049V10.5H7.5V9H9.25098V8.49609C9.25103 6.84139 10.5924 5.5 12.2471 5.5H12.9971V7Z"
                />
              </svg>
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                letterSpacing="0em"
                style={{ whiteSpace: 'pre' }}
              >
                <tspan x={43.533} y={318.791}>
                  Workflows
                </tspan>
              </text>
              <path
                className="fill-gray-900"
                d="M194.984 314.301a.832.832 0 0 1 0 1.177l-2.791 2.791-.882-.882 2.497-2.497-2.497-2.497.882-.883 2.791 2.791Z"
              />
              {/* Sandboxes */}
              <path
                data-hoverable="fill"
                d="M10.24 336.53a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.304a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994V336.53Z"
              />
              <svg x={20.5} y={341} width={13} height={13} viewBox="2 2 16 16">
                <path
                  className="fill-gray-900"
                  d="M16.5 4.25C16.5 3.83579 16.1642 3.5 15.75 3.5H12.5V2H15.75C16.9926 2 18 3.00736 18 4.25V7.5H16.5V4.25ZM2 4.25C2 3.00736 3.00736 2 4.25 2H7.5V3.5H4.25C3.83579 3.5 3.5 3.83579 3.5 4.25V7.5H2V4.25ZM4.93945 12.25L7.18945 10L4.93945 7.75L6 6.68945L8.60352 9.29297C8.99402 9.68349 8.99401 10.3165 8.60352 10.707L6 13.3105L4.93945 12.25ZM9.87207 11.627H14.5V13.127H9.87207V11.627ZM12.5 16.5H15.75C16.1642 16.5 16.5 16.1642 16.5 15.75V12.5H18V15.75C18 16.9926 16.9926 18 15.75 18H12.5V16.5ZM4.25 18C3.00736 18 2 16.9926 2 15.75V12.5H3.5V15.75C3.5 16.1642 3.83579 16.5 4.25 16.5H7.5V18H4.25Z"
                />
              </svg>
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                letterSpacing="0em"
                style={{ whiteSpace: 'pre' }}
              >
                <tspan x={43.533} y={352.083}>
                  Sandboxes
                </tspan>
              </text>
              {/* AI Gateway */}
              <path
                data-hoverable="fill"
                d="M10.24 369.822a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.305a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994v-23.305Z"
              />
              <svg
                x={20.5}
                y={374.3}
                width={13}
                height={13}
                viewBox="2 2 16 16"
              >
                <path
                  className="fill-gray-900"
                  d="M14.25 3C15.7688 3 17 4.23122 17 5.75C17 7.26878 15.7688 8.5 14.25 8.5C13.7631 8.5 13.3069 8.37141 12.9102 8.14941L8.14941 12.9102C8.37141 13.3069 8.5 13.7631 8.5 14.25C8.5 15.7688 7.26878 17 5.75 17C4.23122 17 3 15.7688 3 14.25C3 12.7312 4.23122 11.5 5.75 11.5C6.23644 11.5 6.69243 11.628 7.08887 11.8496L11.8496 7.08887C11.628 6.69243 11.5 6.23644 11.5 5.75C11.5 4.23122 12.7312 3 14.25 3ZM14.25 11.5C15.7688 11.5 17 12.7312 17 14.25C17 15.7688 15.7688 17 14.25 17C12.7312 17 11.5 15.7688 11.5 14.25C11.5 12.7312 12.7312 11.5 14.25 11.5ZM5.75 13C5.05964 13 4.5 13.5596 4.5 14.25C4.5 14.9404 5.05964 15.5 5.75 15.5C6.44036 15.5 7 14.9404 7 14.25C7 13.5596 6.44036 13 5.75 13ZM14.25 13C13.5596 13 13 13.5596 13 14.25C13 14.9404 13.5596 15.5 14.25 15.5C14.9404 15.5 15.5 14.9404 15.5 14.25C15.5 13.5596 14.9404 13 14.25 13ZM5.75 3C7.26878 3 8.5 4.23122 8.5 5.75C8.5 7.26878 7.26878 8.5 5.75 8.5C4.23122 8.5 3 7.26878 3 5.75C3 4.23122 4.23122 3 5.75 3ZM5.75 4.5C5.05964 4.5 4.5 5.05964 4.5 5.75C4.5 6.44036 5.05964 7 5.75 7C6.44036 7 7 6.44036 7 5.75C7 5.05964 6.44036 4.5 5.75 4.5ZM14.25 4.5C13.5596 4.5 13 5.05964 13 5.75C13 6.44036 13.5596 7 14.25 7C14.9404 7 15.5 6.44036 15.5 5.75C15.5 5.05964 14.9404 4.5 14.25 4.5Z"
                />
              </svg>
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                letterSpacing="0em"
                style={{ whiteSpace: 'pre' }}
              >
                <tspan x={43.533} y={385.376}>
                  AI Gateway
                </tspan>
              </text>
              <path
                className="fill-gray-900"
                d="M194.984 380.886a.834.834 0 0 1 0 1.178l-2.791 2.791-.882-.883 2.497-2.497-2.497-2.497.882-.883 2.791 2.791Z"
              />
              {/* Storage */}
              <path
                data-hoverable="fill"
                d="M10.24 403.115a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.304a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994v-23.304Z"
              />
              <svg
                x={20.5}
                y={407.6}
                width={13}
                height={13}
                viewBox="2 2 16 16"
              >
                <path
                  className="fill-gray-900"
                  d="M10 2C11.7969 2 13.4585 2.29022 14.6982 2.78613C15.3159 3.03324 15.8664 3.34654 16.2744 3.73242C16.6839 4.11983 17 4.63232 17 5.25V14.75C17 15.3677 16.6839 15.8802 16.2744 16.2676C15.8664 16.6535 15.3159 16.9668 14.6982 17.2139C13.4585 17.7098 11.7969 18 10 18C8.20312 18 6.54153 17.7098 5.30176 17.2139C4.68408 16.9668 4.13362 16.6535 3.72559 16.2676C3.31606 15.8802 3 15.3677 3 14.75V5.25C3 4.63232 3.31606 4.11983 3.72559 3.73242C4.13362 3.34654 4.68408 3.03324 5.30176 2.78613C6.54153 2.29022 8.20312 2 10 2ZM15.5 12.0791C15.2517 12.2214 14.9824 12.3502 14.6982 12.4639C13.4585 12.9598 11.7969 13.25 10 13.25C8.20312 13.25 6.54153 12.9598 5.30176 12.4639C5.01756 12.3502 4.74835 12.2214 4.5 12.0791V14.75C4.5 14.8225 4.53404 14.967 4.75684 15.1777C4.98126 15.39 5.34616 15.616 5.85938 15.8213C6.88165 16.2302 8.34519 16.5 10 16.5C11.6548 16.5 13.1184 16.2302 14.1406 15.8213C14.6538 15.616 15.0187 15.39 15.2432 15.1777C15.466 14.967 15.5 14.8225 15.5 14.75V12.0791ZM15.5 7.3291C15.2517 7.47137 14.9824 7.60017 14.6982 7.71387C13.4585 8.20978 11.7969 8.5 10 8.5C8.20312 8.5 6.54153 8.20978 5.30176 7.71387C5.01756 7.60017 4.74835 7.47137 4.5 7.3291V10C4.5 10.0725 4.53404 10.217 4.75684 10.4277C4.98126 10.64 5.34616 10.866 5.85938 11.0713C6.88165 11.4802 8.34519 11.75 10 11.75C11.6548 11.75 13.1184 11.4802 14.1406 11.0713C14.6538 10.866 15.0187 10.64 15.2432 10.4277C15.466 10.217 15.5 10.0725 15.5 10V7.3291ZM10 3.5C8.34519 3.5 6.88165 3.76984 5.85938 4.17871C5.34616 4.384 4.98126 4.61003 4.75684 4.82227C4.53404 5.03298 4.5 5.1775 4.5 5.25C4.5 5.3225 4.53404 5.46702 4.75684 5.67773C4.98126 5.88997 5.34616 6.116 5.85938 6.32129C6.88165 6.73016 8.34519 7 10 7C11.6548 7 13.1184 6.73016 14.1406 6.32129C14.6538 6.116 15.0187 5.88997 15.2432 5.67773C15.466 5.46702 15.5 5.3225 15.5 5.25C15.5 5.1775 15.466 5.03298 15.2432 4.82227C15.0187 4.61003 14.6538 4.384 14.1406 4.17871C13.1184 3.76984 11.6548 3.5 10 3.5Z"
                />
              </svg>
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                letterSpacing="0em"
                style={{ whiteSpace: 'pre' }}
              >
                <tspan x={43.533} y={418.669}>
                  Storage
                </tspan>
              </text>
              <g transform="translate(0, 66)">
                <path
                  className="stroke-gray-alpha-400"
                  strokeWidth={0.832}
                  d="M20.227 369.406h179.664"
                />
                <path
                  data-hoverable="fill"
                  d="M10.24 379.81a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.305a4.992 4.992 0 0 1-4.993 4.993H15.234a4.993 4.993 0 0 1-4.994-4.993V379.81Z"
                />
                <svg
                  x={20.5}
                  y={384.3}
                  width={13}
                  height={13}
                  viewBox="2 2 16 16"
                >
                  <path
                    className="fill-gray-900"
                    d="M10 2C14.4183 2 18 5.58172 18 10C18 14.4183 14.4183 18 10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2ZM9.25 3.54395C6.01348 3.91585 3.5 6.66385 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.3362 16.5 16.0841 13.9865 16.4561 10.75H10.25C9.69772 10.75 9.25 10.3023 9.25 9.75V3.54395ZM10.75 9.25H16.4561C16.1124 6.25961 13.7404 3.88757 10.75 3.54395V9.25Z"
                  />
                </svg>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={11.652}
                  letterSpacing="0em"
                  style={{
                    whiteSpace: 'pre',
                  }}
                >
                  <tspan x={43.533} y={395.364}>
                    Usage
                  </tspan>
                </text>
                <path
                  data-hoverable="fill"
                  d="M10.24 413.102a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.305a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994v-23.305Z"
                />
                <svg
                  x={20.5}
                  y={417.6}
                  width={13}
                  height={13}
                  viewBox="2 2 16 16"
                >
                  <path
                    className="fill-gray-900"
                    d="M10 2C14.4183 2 18 5.58172 18 10C18 14.4183 14.4183 18 10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2ZM10 3.5C6.41015 3.5 3.5 6.41015 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.41015 13.5899 3.5 10 3.5ZM10 6.5C11.933 6.5 13.5 8.067 13.5 10C13.5 11.933 11.933 13.5 10 13.5C8.067 13.5 6.5 11.933 6.5 10C6.5 8.067 8.067 6.5 10 6.5ZM10 8C8.89543 8 8 8.89543 8 10C8 11.1046 8.89543 12 10 12C11.1046 12 12 11.1046 12 10C12 8.89543 11.1046 8 10 8Z"
                  />
                  <path
                    className="fill-gray-900"
                    d="M9.29785 11.8701C9.51661 11.9523 9.75253 12 10 12V18C9.01115 18 8.0647 17.8193 7.19043 17.4912L9.29785 11.8701ZM12.8086 17.4912C11.9346 17.8191 10.9885 18 10 18V12C10.2471 12 10.4827 11.9521 10.7012 11.8701L12.8086 17.4912ZM8.12891 9.29785C8.04681 9.51652 8 9.75266 8 10C8 10.247 8.04702 10.4827 8.12891 10.7012L2.50781 12.8086C2.18005 11.9347 2 10.9884 2 10C2 9.01127 2.17984 8.06461 2.50781 7.19043L8.12891 9.29785ZM17.4912 7.19043C17.8193 8.0647 18 9.01115 18 10C18 10.9885 17.8191 11.9346 17.4912 12.8086L11.8701 10.7012C11.9521 10.4827 12 10.2471 12 10C12 9.75253 11.9523 9.51661 11.8701 9.29785L17.4912 7.19043ZM10 2C10.9884 2 11.9347 2.18005 12.8086 2.50781L10.7012 8.12891C10.4827 8.04702 10.247 8 10 8C9.75266 8 9.51652 8.04681 9.29785 8.12891L7.19043 2.50781C8.06461 2.17984 9.01127 2 10 2Z"
                  />
                </svg>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={11.652}
                  letterSpacing="0em"
                  style={{
                    whiteSpace: 'pre',
                  }}
                >
                  <tspan x={43.533} y={428.656}>
                    Support
                  </tspan>
                </text>
                <path
                  data-hoverable="fill"
                  d="M10.24 446.395a4.994 4.994 0 0 1 4.994-4.994h189.652a4.993 4.993 0 0 1 4.993 4.994v23.304a4.993 4.993 0 0 1-4.993 4.994H15.234a4.994 4.994 0 0 1-4.994-4.994v-23.304Z"
                />
                <svg
                  x={20.5}
                  y={450.9}
                  width={13}
                  height={13}
                  viewBox="2 2 16 16"
                >
                  <path
                    className="fill-gray-900"
                    d="M11.7734 3.45996C11.8081 3.64475 11.9444 3.79302 12.1221 3.85449C12.3698 3.94004 12.6116 4.03968 12.8447 4.15332C13.0139 4.23571 13.2148 4.22736 13.3701 4.12109L14.5967 3.28223L16.7178 5.40332L15.8789 6.62988C15.7726 6.7852 15.7643 6.98608 15.8467 7.15527C15.9603 7.38842 16.06 7.63018 16.1455 7.87793C16.207 8.05561 16.3553 8.19185 16.54 8.22656L18 8.5V11.5L16.54 11.7734C16.3553 11.8081 16.207 11.9444 16.1455 12.1221C16.06 12.3698 15.9603 12.6116 15.8467 12.8447C15.7643 13.0139 15.7726 13.2148 15.8789 13.3701L16.7178 14.5967L14.5957 16.7178L13.3701 15.8789C13.2148 15.7726 13.0139 15.7643 12.8447 15.8467C12.6116 15.9603 12.3698 16.06 12.1221 16.1455C11.9444 16.207 11.8081 16.3552 11.7734 16.54L11.5 18H8.5L8.22656 16.54C8.19619 16.3784 8.08791 16.2449 7.94238 16.1729L7.87793 16.1455C7.63019 16.06 7.38842 15.9603 7.15527 15.8467C6.98608 15.7643 6.7852 15.7726 6.62988 15.8789L5.40332 16.7178L3.28223 14.5967L4.12109 13.3701C4.21409 13.2342 4.23278 13.0632 4.18066 12.9092L4.15332 12.8447C4.03967 12.6116 3.94004 12.3698 3.85449 12.1221C3.80069 11.9665 3.6804 11.8427 3.52734 11.791L3.45996 11.7734L2 11.5V8.5L3.45996 8.22656C3.62164 8.19619 3.75509 8.08791 3.82715 7.94238L3.85449 7.87793C3.94004 7.63018 4.03968 7.38843 4.15332 7.15527C4.22539 7.00726 4.2279 6.83527 4.15625 6.69043L4.12109 6.62988L3.28223 5.40332L5.40332 3.28223L6.62988 4.12109C6.78521 4.22737 6.98608 4.23571 7.15527 4.15332C7.27178 4.09653 7.39047 4.04306 7.51074 3.99316L7.87793 3.85449C8.03345 3.80069 8.1573 3.6804 8.20898 3.52734L8.22656 3.45996L8.5 2H11.5L11.7734 3.45996ZM9.7002 3.73633C9.55891 4.4894 9.0164 5.04829 8.36719 5.27246C8.27217 5.30527 8.1783 5.34059 8.08594 5.37891L7.69531 5.55469C7.09825 5.80009 6.37631 5.76503 5.7832 5.35938L5.58398 5.22266L5.22266 5.58398L5.35938 5.7832C5.76504 6.37631 5.80009 7.09825 5.55469 7.69531L5.37891 8.08594C5.34059 8.17831 5.30527 8.27217 5.27246 8.36719C5.04829 9.01639 4.48939 9.55891 3.73633 9.7002L3.5 9.74414V10.2549L3.73633 10.2998C4.44244 10.4323 4.97778 10.9175 5.22656 11.5127L5.27246 11.6328L5.37891 11.9141L5.55469 12.3047C5.80009 12.9017 5.76503 13.6237 5.35938 14.2168L5.22266 14.415L5.58398 14.7764L5.7832 14.6406L5.90332 14.5645C6.4719 14.2315 7.13802 14.2163 7.69531 14.4453L8.08594 14.6211C8.1783 14.6594 8.27217 14.6947 8.36719 14.7275C9.0164 14.9517 9.55891 15.5106 9.7002 16.2637L9.74414 16.5H10.2559L10.2998 16.2637L10.3301 16.125C10.5084 15.4421 11.0241 14.9377 11.6328 14.7275C11.7278 14.6947 11.8217 14.6594 11.9141 14.6211L12.3047 14.4453C12.9017 14.1999 13.6237 14.235 14.2168 14.6406L14.415 14.7764L14.7764 14.415L14.6406 14.2168C14.235 13.6237 14.1999 12.9018 14.4453 12.3047L14.6211 11.9141C14.6594 11.8217 14.6947 11.7278 14.7275 11.6328C14.9517 10.9836 15.5106 10.4411 16.2637 10.2998L16.5 10.2549V9.74414L16.2637 9.7002C15.5106 9.55891 14.9517 9.0164 14.7275 8.36719C14.6947 8.27217 14.6594 8.17831 14.6211 8.08594L14.4453 7.69531C14.1999 7.09825 14.235 6.3763 14.6406 5.7832L14.7764 5.58398L14.415 5.22266L14.2168 5.35938C13.6237 5.76504 12.9018 5.80009 12.3047 5.55469L11.9141 5.37891C11.8217 5.34059 11.7278 5.30527 11.6328 5.27246C10.9836 5.04829 10.4411 4.4894 10.2998 3.73633L10.2559 3.5H9.74414L9.7002 3.73633ZM10 7C11.6569 7 13 8.34315 13 10C13 11.6569 11.6569 13 10 13C8.34315 13 7 11.6569 7 10C7 8.34315 8.34315 7 10 7ZM10 8.5C9.17157 8.5 8.5 9.17157 8.5 10C8.5 10.8284 9.17157 11.5 10 11.5C10.8284 11.5 11.5 10.8284 11.5 10C11.5 9.17157 10.8284 8.5 10 8.5Z"
                  />
                </svg>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={11.652}
                  letterSpacing="0em"
                  style={{
                    whiteSpace: 'pre',
                  }}
                >
                  <tspan x={43.533} y={461.949}>
                    Settings
                  </tspan>
                </text>
                <path
                  className="fill-gray-900"
                  d="M194.984 457.459a.834.834 0 0 1 0 1.178l-2.791 2.791-.882-.883 2.497-2.497-2.497-2.497.882-.883 2.791 2.791Z"
                />
              </g>
            </g>
            <g clipPath={`url(#q-${svgId})`}>
              <mask id={`r-${svgId}`} fill="#fff">
                <path d="M216.538 45.22h610.94v46.548h-610.94V45.22Z" />
              </mask>
              <path
                className="fill-gray-alpha-100"
                d="M827.478 91.768v-.832h-610.94V92.6h610.94v-.832Z"
                mask={`url(#r-${svgId})`}
              />
              {/* Project selector with Vercel logo */}
              <path
                data-hoverable="fill"
                d="M233 60.171a4.994 4.994 0 0 1 4.994-4.994h108a4.994 4.994 0 0 1 4.994 4.994v16.646a4.994 4.994 0 0 1-4.994 4.994h-108a4.994 4.994 0 0 1-4.994-4.994V60.171Z"
              />
              <rect
                x={239}
                y={62}
                width={12}
                height={12}
                rx={3}
                className="fill-gray-1000"
              />
              <path
                className="fill-background-100"
                d="m245 65 3 5.4h-6l3-5.4Z"
              />
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                fontWeight={500}
                letterSpacing="0em"
                style={{
                  whiteSpace: 'pre',
                }}
              >
                <tspan x={257} y={72.396}>
                  acme-store
                </tspan>
              </text>
              <path
                className="fill-gray-900"
                d="m340.645 70.398-2.791 2.791a.832.832 0 0 1-1.177 0l-2.791-2.791.882-.883 2.497 2.497 2.497-2.497.883.883Zm-3.968-6.536a.833.833 0 0 1 1.114-.058l.063.058 2.791 2.79-.883.884-2.497-2.497-2.497 2.497-.882-.883 2.791-2.791Z"
              />
              <text
                xmlSpace="preserve"
                className="fill-gray-1000"
                fontFamily="Geist"
                fontSize={11.652}
                fontWeight={500}
                letterSpacing="0em"
                style={{
                  whiteSpace: 'pre',
                }}
              >
                <tspan x={500.744} y={72.396}>
                  Workflows
                </tspan>
              </text>
              <path
                data-hoverable="fill"
                d="M787.527 60.171a4.994 4.994 0 0 1 4.994-4.994h16.646a4.994 4.994 0 0 1 4.994 4.994v16.646a4.994 4.994 0 0 1-4.994 4.994h-16.646a4.994 4.994 0 0 1-4.994-4.994V60.171Z"
              />
              <path
                className="fill-gray-900"
                d="M796.267 67.246a1.25 1.25 0 0 1 0 2.497 1.248 1.248 0 0 1 0-2.497Zm4.578 0a1.248 1.248 0 1 1 0 2.496 1.248 1.248 0 0 1 0-2.496Zm4.578 0a1.248 1.248 0 1 1 0 2.497 1.248 1.248 0 0 1 0-2.497Z"
              />
              <g transform="translate(0, 8)">
                {/* Observability trace visualization */}
                {/* 13 vertical grid lines from content left (237) to right (807) */}
                {Array.from({ length: 13 }, (_, i) => {
                  const x = 237 + ((807 - 237) / 12) * i;
                  return (
                    <line
                      // biome-ignore lint/suspicious/noArrayIndexKey: static grid lines with fixed positions
                      key={`grid-${i}`}
                      x1={x}
                      y1={155}
                      x2={x}
                      y2={485}
                      className="stroke-gray-alpha-200"
                      strokeWidth={0.6}
                    />
                  );
                })}

                {/* Status header card */}
                <rect
                  x={237}
                  y={102}
                  width={570}
                  height={42}
                  rx={6}
                  className="fill-background-100 stroke-gray-alpha-400"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-gray-900"
                  fontFamily="Geist"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={246} y={119}>
                    Status
                  </tspan>
                </text>
                <circle cx={249} cy={131} r={3} className="fill-geist-cyan" />
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={9.5}
                  fontWeight={500}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={257} y={134}>
                    Completed
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-900"
                  fontFamily="Geist"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={330} y={119}>
                    Run ID
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={9.5}
                  fontWeight={500}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={330} y={134}>
                    wrun_02456KXR
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-900"
                  fontFamily="Geist"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={800} y={119} textAnchor="end">
                    Duration
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-gray-1000"
                  fontFamily="Geist"
                  fontSize={9.5}
                  fontWeight={500}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={800} y={134} textAnchor="end">
                    925ms
                  </tspan>
                </text>

                {/* workflow() bar — blue, full width */}
                <rect
                  x={237}
                  y={155}
                  width={570}
                  height={22}
                  rx={4}
                  className="fill-blue-200 stroke-blue-700"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-blue-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={245} y={170}>
                    workflow()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-blue-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={799} y={170} textAnchor="end">
                    925ms
                  </tspan>
                </text>

                {/* fetchOrder() — green, left-aligned */}
                <rect
                  x={237}
                  y={184}
                  width={148}
                  height={22}
                  rx={4}
                  className="fill-green-100 stroke-green-600"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={245} y={199}>
                    fetchOrder()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={377} y={199} textAnchor="end">
                    230ms
                  </tspan>
                </text>

                {/* validate() */}
                <rect
                  x={380}
                  y={213}
                  width={120}
                  height={22}
                  rx={4}
                  className="fill-green-100 stroke-green-600"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={388} y={228}>
                    validate()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={492} y={228} textAnchor="end">
                    155ms
                  </tspan>
                </text>

                {/* enrichWithPricing() */}
                <rect
                  x={495}
                  y={242}
                  width={165}
                  height={22}
                  rx={4}
                  className="fill-green-100 stroke-green-600"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={503} y={257}>
                    enrichWithPricing()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={652} y={257} textAnchor="end">
                    230ms
                  </tspan>
                </text>

                {/* saveOrder() */}
                <rect
                  x={655}
                  y={271}
                  width={120}
                  height={22}
                  rx={4}
                  className="fill-green-100 stroke-green-600"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={663} y={286}>
                    saveOrder()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={767} y={286} textAnchor="end">
                    155ms
                  </tspan>
                </text>

                {/* sendEmail() */}
                <rect
                  x={690}
                  y={300}
                  width={117}
                  height={22}
                  rx={4}
                  className="fill-green-100 stroke-green-600"
                  strokeWidth={0.832}
                />
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={698} y={315}>
                    sendEmail()
                  </tspan>
                </text>
                <text
                  xmlSpace="preserve"
                  className="fill-green-900"
                  fontFamily="Geist Mono"
                  fontSize={9.5}
                  letterSpacing="0em"
                  style={{ whiteSpace: 'pre' }}
                >
                  <tspan x={799} y={315} textAnchor="end">
                    155ms
                  </tspan>
                </text>
              </g>
            </g>
          </g>
          <path
            className="fill-gray-alpha-400"
            d="M3.582 45.22v1.164h823.896v-2.327H3.582v1.163Z"
            mask={`url(#P-${svgId})`}
          />
          <path
            className="fill-gray-500"
            d="M379.327 19.128a3 3 0 0 1 3 3v1h1v4.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-4.5h1v-1a3 3 0 0 1 3-3Zm0 1.5a1.5 1.5 0 0 0-1.5 1.5v1h3v-1a1.5 1.5 0 0 0-1.5-1.5Z"
          />
          <text
            xmlSpace="preserve"
            className="fill-gray-700"
            fontFamily="Geist"
            fontSize={12}
            letterSpacing="0em"
            style={{
              whiteSpace: 'pre',
            }}
          >
            <tspan x={391.327} y={28.328}>
              vercel.com
            </tspan>
          </text>
        </g>
        <path
          className="stroke-gray-alpha-400"
          d="M814.096.5c7.988 0 14.463 6.476 14.464 14.464v456.169c0 7.988-6.476 14.465-14.464 14.465H16.965c-7.989 0-14.465-6.477-14.465-14.465V14.963C2.5 6.977 8.976.5 16.964.5h797.132Z"
          shapeRendering="crispEdges"
        />
      </g>
      <defs>
        <clipPath id={`b-${svgId}`}>
          <path
            fill="#fff"
            d="M3 14.964C3 7.252 9.252 1 16.964 1h797.132c7.712 0 13.964 6.252 13.964 13.964v456.169c0 7.712-6.252 13.964-13.964 13.964H16.964C9.252 485.097 3 478.845 3 471.133V14.964Z"
          />
        </clipPath>
        <clipPath id={`c-${svgId}`}>
          <path fill="#fff" d="M3.582 45.22h823.896V844.68H3.582V45.22Z" />
        </clipPath>
        <clipPath id={`e-${svgId}`}>
          <rect
            width={16.646}
            height={16.646}
            x={18.564}
            y={60.202}
            fill="#fff"
            rx={8.323}
          />
        </clipPath>
        <clipPath id={`g-${svgId}`}>
          <path fill="#fff" d="M20.227 101.818h13.317v13.317H20.228z" />
        </clipPath>
        <clipPath id={`h-${svgId}`}>
          <path fill="#fff" d="M20.229 141.769h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`i-${svgId}`}>
          <path fill="#fff" d="M20.229 175.061h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`j-${svgId}`}>
          <path fill="#fff" d="M20.229 274.938h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`k-${svgId}`}>
          <path fill="#fff" d="M20.229 308.231h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`l-${svgId}`}>
          <path fill="#fff" d="M20.229 341.523h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`n-${svgId}`}>
          <path fill="#fff" d="M20.229 384.804h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`o-${svgId}`}>
          <path fill="#fff" d="M20.229 418.096h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`p-${svgId}`}>
          <path fill="#fff" d="M20.229 451.389h13.317v13.317H20.229z" />
        </clipPath>
        <clipPath id={`q-${svgId}`}>
          <path fill="#fff" d="M216.538 45.22h610.94v457.564h-610.94z" />
        </clipPath>
        <clipPath id={`t-${svgId}`}>
          <path fill="#fff" d="M243.173 156.21h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`u-${svgId}`}>
          <path fill="#fff" d="M490.939 172.024h13.317v13.317h-13.317z" />
        </clipPath>
        <clipPath id={`v-${svgId}`}>
          <path fill="#fff" d="M736.179 156.21h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`x-${svgId}`}>
          <path
            fill="#fff"
            d="M229.855 247.286a6.66 6.66 0 0 1 6.659-6.659h570.989a6.66 6.66 0 0 1 6.659 6.659v235.523a6.66 6.66 0 0 1-6.659 6.659H236.514a6.66 6.66 0 0 1-6.659-6.659V247.286Z"
          />
        </clipPath>
        <clipPath id={`z-${svgId}`}>
          <path fill="#fff" d="M243.173 258.46h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`C-${svgId}`}>
          <path fill="#fff" d="M490.939 274.273h13.317v13.317h-13.317z" />
        </clipPath>
        <clipPath id={`D-${svgId}`}>
          <path fill="#fff" d="M736.179 258.46h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`F-${svgId}`}>
          <path fill="#fff" d="M243.173 320.758h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`G-${svgId}`}>
          <path fill="#fff" d="M490.939 336.572h13.317v13.317h-13.317z" />
        </clipPath>
        <clipPath id={`H-${svgId}`}>
          <path fill="#fff" d="M736.179 320.758h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`J-${svgId}`}>
          <path fill="#fff" d="M243.173 383.057h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`K-${svgId}`}>
          <path fill="#fff" d="M490.939 398.871h13.317v13.317h-13.317z" />
        </clipPath>
        <clipPath id={`L-${svgId}`}>
          <path fill="#fff" d="M736.179 383.057h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`M-${svgId}`}>
          <path fill="#fff" d="M243.173 445.179h26.634v26.634h-26.634z" />
        </clipPath>
        <clipPath id={`N-${svgId}`}>
          <path fill="#fff" d="M490.939 460.992h13.317v13.317h-13.317z" />
        </clipPath>
        <clipPath id={`O-${svgId}`}>
          <path fill="#fff" d="M736.179 445.179h26.634v26.634h-26.634z" />
        </clipPath>
        <filter
          id={`a-${svgId}`}
          width={831.06}
          height={494.097}
          x={0}
          y={0}
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            result="hardAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feMorphology
            in="SourceAlpha"
            radius={8}
            result="effect1_dropShadow_2675_16111"
          />
          <feOffset dy={8} />
          <feGaussianBlur stdDeviation={4} />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0" />
          <feBlend
            in2="BackgroundImageFix"
            result="effect1_dropShadow_2675_16111"
          />
          <feColorMatrix
            in="SourceAlpha"
            result="hardAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feOffset dy={2} />
          <feGaussianBlur stdDeviation={1} />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0" />
          <feBlend
            in2="effect1_dropShadow_2675_16111"
            result="effect2_dropShadow_2675_16111"
          />
          <feBlend
            in="SourceGraphic"
            in2="effect2_dropShadow_2675_16111"
            result="shape"
          />
        </filter>
        <filter
          id={`s-${svgId}`}
          width={589.3}
          height={67.293}
          x={227.359}
          y={136.713}
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            result="hardAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feOffset dy={0.832} />
          <feGaussianBlur stdDeviation={0.832} />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0" />
          <feBlend
            in2="BackgroundImageFix"
            result="effect1_dropShadow_2675_16111"
          />
          <feBlend
            in="SourceGraphic"
            in2="effect1_dropShadow_2675_16111"
            result="shape"
          />
        </filter>
        <filter
          id={`w-${svgId}`}
          width={589.3}
          height={253.835}
          x={227.359}
          y={238.963}
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            result="hardAlpha"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
          />
          <feOffset dy={0.832} />
          <feGaussianBlur stdDeviation={0.832} />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0" />
          <feBlend
            in2="BackgroundImageFix"
            result="effect1_dropShadow_2675_16111"
          />
          <feBlend
            in="SourceGraphic"
            in2="effect1_dropShadow_2675_16111"
            result="shape"
          />
        </filter>
        <linearGradient
          id={`A-${svgId}`}
          x1={261.368}
          x2={261.368}
          y1={266.783}
          y2={276.77}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset={0.609} stopColor="#fff" stopOpacity={0.57} />
          <stop offset={0.797} stopColor="#fff" stopOpacity={0} />
          <stop offset={1} stopColor="#fff" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id={`B-${svgId}`}
          x1={259.323}
          x2={264.464}
          y1={275.893}
          y2={282.452}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset={0.604} stopColor="#fff" stopOpacity={0} />
          <stop offset={1} stopColor="#fff" stopOpacity={0} />
        </linearGradient>
        <pattern
          id={`f-${svgId}`}
          width={1}
          height={1}
          patternContentUnits="objectBoundingBox"
        >
          <use href={`#Q-${svgId}`} transform="scale(.00781)" />
        </pattern>
        <image
          href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAGFBMVEUAAAD////i4uIgICBXV1efn5+AgIC/v78wfo1rAAAACXBIWXMAAAsTAAALEwEAmpwYAAABOklEQVR4nO2Z2w6CQBBD6Vzg///YqPG6K4IuWw09j2aSIYdpY8IwCCGEEEIIIYQQQnxHxMDFjLs/gJG53w2gKkiAqsCP+wHnCgAm1v447wdYUbTLAxhZADh36FcBJAV5209R4Pf7GVHMxweYiBfIiaLhCSMLQN879EJAZwVZ7u+qwGv7AbIAJPMC+3aRgXsCUd1vzowgejZh1gWwIxi7ERBsAbbzDnK2gGQLALmEk1zC8ZsRtHJwIguIba7Clwpw26aZc6mAcZtgOBZ20HnQeR2Up9+nTheYL021DqetE9D8H0LU948zg2OPCHoxeRs0SgRjVk/rCFo5+WDKuQLQLoqxVMDzqcS2EYxqCb95R106qPEd+uoOaqwgPxfQRIHjcwFNopjrS/ge2scMIYQQQgghhBBCCCHE/3AA5EMHEr19d1cAAAAASUVORK5CYII="
          id={`Q-${svgId}`}
          width={128}
          height={128}
          preserveAspectRatio="none"
        />
      </defs>
    </svg>
  );
};
