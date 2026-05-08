interface Props {
  ip: string
  className?: string
}

export default function IpLink({ ip, className = '' }: Props) {
  if (!ip || ip === 'Unknown' || ip === '-') {
    return <span className={className}>{ip}</span>
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="font-mono">{ip}</span>
      <a
        href={`https://whatismyipaddress.com/ip/${ip}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Look up ${ip} on whatismyipaddress.com`}
        onClick={e => e.stopPropagation()}
        className="text-gray-300 hover:text-blue-500 transition-colors shrink-0"
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
          <path d="M8.5 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V3.707L6.354 9.854a.5.5 0 1 1-.708-.708L11.793 3H9a.5.5 0 0 1-.5-.5z"/>
          <path d="M14 8.5a.5.5 0 0 1 .5.5v4A1.5 1.5 0 0 1 13 14.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5h4a.5.5 0 0 1 0 1H3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9a.5.5 0 0 1 .5-.5z"/>
        </svg>
      </a>
    </span>
  )
}
