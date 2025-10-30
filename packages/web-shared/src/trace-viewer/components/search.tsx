import { type ReactNode, useEffect, useState } from 'react';
import { useTraceViewer } from '../context';
import styles from '../trace-viewer.module.css';
import { SEARCH_HEIGHT } from '../util/constants';
import { SearchInput } from './search-input';

export function SearchBar(): ReactNode {
  return (
    <nav className={styles.searchBar}>
      <SearchInputWrapper />
    </nav>
  );
}

function SearchInputWrapper(): ReactNode {
  const { dispatch } = useTraceViewer();
  const [value, setValue] = useState('');

  useEffect(() => {
    const timeout = setTimeout(
      () =>
        dispatch({
          type: 'setFilter',
          filter: value,
        }),
      100
    );

    return () => {
      clearTimeout(timeout);
    };
  }, [dispatch, value]);

  return (
    <div className={styles.searchInput}>
      <SearchInput
        height={SEARCH_HEIGHT}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search spans…"
        value={value}
        width="100%"
      />
    </div>
  );
}
