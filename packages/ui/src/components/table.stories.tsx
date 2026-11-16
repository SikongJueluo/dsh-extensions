import type { Meta, StoryObj } from '@storybook/react-vite'
import { Root, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../index'

const meta = {
  title: 'UI/Table',
  decorators: [
    (Story) => (
      <Root>
        <Story />
      </Root>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj

export const DenseStats: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Route</TableHead>
          <TableHead>Calls</TableHead>
          <TableHead>Failures</TableHead>
          <TableHead>Cache hit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          ['deepseek/deepseek-chat', '1,284', '3', '82%'],
          ['deepseek/deepseek-reasoner', '318', '0', '64%'],
          ['openai/gpt-5-codex-with-a-very-long-route-name-that-needs-to-wrap', '97', '1', '51%'],
        ].map((row) => (
          <TableRow key={row[0]}>
            {row.map((cell, index) => (
              <TableCell key={cell} className={index === 0 ? 'dshx:break-all' : undefined}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
}
