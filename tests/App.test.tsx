import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app/App';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Luma browser interface', () => {
  it('renders the new tab page and opens a new tab', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '新标签页' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: '网页内容区域' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开主页' }));
    expect(screen.getByRole('heading', { name: '今天，想去哪里？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建标签页 (Ctrl+T)' }));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('opens the bookmark manager from the omnibox', () => {
    render(<App />);
    const address = screen.getByRole('textbox', { name: '地址和搜索栏' });
    fireEvent.change(address, { target: { value: 'luma://bookmarks' } });
    fireEvent.submit(address.closest('form')!);
    expect(screen.getByRole('heading', { name: '书签', level: 1 })).toBeInTheDocument();
    expect(within(screen.getByRole('main', { name: '网页内容区域' })).getByRole('button', { name: '添加书签' })).toBeInTheDocument();
  });

  it('navigates settings sections and adds a custom search engine', () => {
    render(<App />);
    const address = screen.getByRole('textbox', { name: '地址和搜索栏' });
    fireEvent.change(address, { target: { value: 'luma://settings' } });
    fireEvent.submit(address.closest('form')!);

    fireEvent.click(screen.getByRole('button', { name: '快捷键' }));
    expect(screen.getByRole('heading', { name: '键盘快捷键' })).toBeInTheDocument();
    expect(screen.getByText('恢复关闭的标签页')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '搜索引擎' }));
    fireEvent.click(screen.getByRole('button', { name: '添加自定义' }));
    fireEvent.change(screen.getByLabelText('搜索引擎名称'), { target: { value: '站内搜索' } });
    fireEvent.change(screen.getByLabelText(/搜索地址/), {
      target: { value: 'https://search.example.com/?q=%s' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加并设为默认' }));
    expect(screen.getByRole('radio', { name: /站内搜索/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('changes the default search engine from the home page', () => {
    render(<App />);
    const engine = screen.getByLabelText('选择默认搜索引擎');
    fireEvent.change(engine, { target: { value: 'google' } });
    expect(engine).toHaveValue('google');
    expect(screen.getByRole('textbox', { name: '搜索网络或输入网址' })).toHaveAttribute(
      'placeholder',
      '在 Google 中搜索，或输入网址',
    );
  });

  it('shows validation feedback for an invalid address', () => {
    render(<App />);
    const address = screen.getByRole('textbox', { name: '地址和搜索栏' });
    fireEvent.change(address, { target: { value: 'http://' } });
    fireEvent.submit(address.closest('form')!);
    expect(screen.getByText('无法打开这个地址')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新标签页' })).toBeInTheDocument();
  });
});
