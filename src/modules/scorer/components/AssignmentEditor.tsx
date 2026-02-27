import type { Member } from '../../../types'

interface AssignmentEditorProps {
  label: string
  teamValue: string
  personValue: string
  members: Member[]
  onTeamChange: (value: string) => void
  onPersonChange: (value: string) => void
  disabled: boolean
}

export default function AssignmentEditor({
  label,
  teamValue,
  personValue,
  members,
  onTeamChange,
  onPersonChange,
  disabled,
}: AssignmentEditorProps) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-gray-500">{label}</span>
      <input
        type="text"
        value={teamValue}
        onChange={(e) => onTeamChange(e.target.value)}
        disabled={disabled}
        placeholder="Team"
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50 disabled:text-gray-500"
      />
      <select
        value={personValue}
        onChange={(e) => onPersonChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50 disabled:text-gray-500"
      >
        <option value="">— Person wählen —</option>
        {members.map((m) => (
          <option key={m.id} value={`${m.first_name} ${m.last_name}`}>
            {m.first_name} {m.last_name}
          </option>
        ))}
      </select>
    </div>
  )
}
