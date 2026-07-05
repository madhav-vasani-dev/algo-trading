import { Routes } from '@angular/router';
import { AuthComponent } from './components/auth/auth.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { LoginComponent } from './components/login/login.component';
import { MainLayoutComponent } from './components/layout/main-layout/main-layout.component';
import { authGuard } from './guards/auth.guard';
import { AccountComponent } from './components/views/account/account.component';
import { BacktestComponent } from './components/views/backtest/backtest.component';
import { SeasonalityComponent } from './components/views/seasonality/seasonality.component';
import { ChartsComponent } from './components/views/charts/charts.component';

export const routes: Routes = [
    // Public Routes
    { path: 'login', component: LoginComponent },
    { path: 'auth/upstox', component: AuthComponent },

    // Protected App Routes wrapped in the Sidebar Layout
    {
        path: '',
        component: MainLayoutComponent,
        canActivate: [authGuard],
        children: [
            { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
            { path: 'dashboard', component: DashboardComponent },
            { path: 'charts', component: ChartsComponent },
            { path: 'backtest', component: BacktestComponent },
            { path: 'seasonality', component: SeasonalityComponent },
            { path: 'account', component: AccountComponent }
        ]
    },

    // Fallback
    { path: '**', redirectTo: 'dashboard' }
];
